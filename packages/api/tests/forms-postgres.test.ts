import { fileURLToPath, URL } from "node:url";
import {
	assertDatabaseIdentity,
	authUser,
	createPgDb,
	createPgPool,
	type DatabaseRoleIdentity,
	formAliases,
	formMonthlyUsage,
	formResponses,
	forms,
	formVersions,
	links,
	type UrlxDb,
	type UrlxDbPool,
} from "@urlx/db";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FormsError, FormsService } from "../src/modules/forms/forms.service";
import { LinkService } from "../src/modules/links/link.service";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const migratorDatabaseUrl = process.env.TEST_MIGRATOR_DATABASE_URL;
const runNamespace = crypto.randomUUID().replaceAll("-", "").slice(0, 8);

describe("forms PostgreSQL integration", () => {
	let pool!: UrlxDbPool;
	let db!: UrlxDb;
	let service!: FormsService;
	const owners = new Set<string>();

	beforeAll(async () => {
		if (!testDatabaseUrl || !migratorDatabaseUrl) {
			throw new Error(
				"Set TEST_DATABASE_URL (urlx_app) and TEST_MIGRATOR_DATABASE_URL (urlx_migrator) to run PostgreSQL integration tests.",
			);
		}
		const migratorPool = createPgPool(migratorDatabaseUrl, { max: 1 });
		try {
			await assertPoolIdentity(migratorPool, "urlx_migrator");
			await migrate(createPgDb(migratorPool), {
				migrationsFolder: fileURLToPath(
					new URL("../../db/src/migrations/pg/", import.meta.url),
				),
			});
		} finally {
			await migratorPool.end();
		}
		pool = createPgPool(testDatabaseUrl, { max: 4 });
		await assertPoolIdentity(pool, "urlx_app");
		db = createPgDb(pool);
		service = new FormsService(db);
	});

	afterAll(async () => {
		if (!pool || !migratorDatabaseUrl) return;
		const cleanupPool = createPgPool(migratorDatabaseUrl, { max: 1 });
		try {
			const cleanupDb = createPgDb(cleanupPool);
			for (const ownerId of owners) {
				const ownedForms = await db
					.select({ shortCode: forms.shortCode })
					.from(forms)
					.where(eq(forms.ownerId, ownerId));
				const codes = ownedForms.flatMap((form) =>
					form.shortCode ? [form.shortCode] : [],
				);
				if (codes.length)
					await cleanupDb.delete(links).where(inArray(links.shortCode, codes));
				await db.delete(authUser).where(eq(authUser.id, ownerId));
			}
		} finally {
			await cleanupPool.end();
			await pool.end();
		}
	});

	it("keeps the runtime role restricted to DML", async () => {
		await expect(
			pool.query("CREATE TABLE public.urlx_permission_probe (id integer)"),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			pool.query("UPDATE public.form_limits SET max_published = max_published"),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			pool.query("UPDATE public.form_owner_locks SET owner_id = owner_id"),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			pool.query(
				"UPDATE public.form_monthly_usage SET response_count = response_count",
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	it("creates and publishes atomically, deduplicates idempotent submissions, and preserves accepted usage after deletion", async () => {
		const ownerId = await createOwner(db, owners);
		const created = await service.create(ownerId, definition("Signup"));
		expect(created?.revision).toBe(1);
		const formId = created!.form.id;

		const published = await service.publish(
			ownerId,
			formId,
			runSlug("signup-form"),
			"https://forms.test",
			"https://short.test",
			"public",
		);
		expect(published?.publishedVersion?.publishedAt).toEqual(
			expect.any(Number),
		);

		const versionId = published!.publishedVersion!.id;
		const first = await service.acceptResponse(
			formId,
			versionId,
			"submission-1",
			{
				name: "Ava",
			},
		);
		const duplicate = await service.acceptResponse(
			formId,
			versionId,
			"submission-1",
			{ name: "Ava" },
		);
		expect(duplicate).toEqual({
			responseId: first.responseId,
			duplicate: true,
		});

		const responseList = await service.responses(ownerId, formId);
		expect(responseList?.total).toBe(1);
		expect(responseList?.stats[0]?.responseCount).toBe(1);
		await service.deleteResponse(ownerId, formId, first.responseId);
		const [usage] = await db
			.select()
			.from(formMonthlyUsage)
			.where(eq(formMonthlyUsage.ownerId, ownerId));
		expect(usage?.responseCount).toBe(1);
	});

	it("publishes first-party loopback form links while generic shortening still blocks private URLs", async () => {
		const ownerId = await createOwner(db, owners);
		const created = await service.create(ownerId, definition("Loopback form"));
		const slug = runSlug("loopback-form");
		const published = await service.publish(
			ownerId,
			created!.form.id,
			slug,
			"http://127.0.0.1:18080",
			"http://127.0.0.1:18080",
			"public",
		);
		expect(published?.url).toBe(`http://127.0.0.1:18080/f/${slug}`);
		expect(published?.shortUrl).toMatch(/^http:\/\/127\.0\.0\.1:18080\/u\//);
		const [link] = await db
			.select()
			.from(links)
			.where(eq(links.shortCode, published!.form.shortCode!))
			.limit(1);
		expect(link?.originalUrl).toBe(`http://127.0.0.1:18080/f/${slug}`);
		await expect(
			new LinkService({ db, shortUrlBase: "https://short.test" }).shorten(
				`http://127.0.0.1:18080/f/${slug}`,
			),
		).rejects.toMatchObject({ code: "PRIVATE_IP_NOT_ALLOWED" });
	});

	it("rolls back slug, alias, version, and publication quota when link persistence fails", async () => {
		const ownerId = await createOwner(db, owners);
		const created = await service.create(ownerId, definition("Link rollback"));
		const slug = runSlug("link-rollback");
		const migrationPool = createPgPool(migratorDatabaseUrl!, { max: 1 });
		const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
		const functionName = `urlx_test_reject_form_link_${suffix}`;
		const triggerName = `urlx_test_reject_form_link_${suffix}`;
		try {
			await assertPoolIdentity(migrationPool, "urlx_migrator");
			await migrationPool.query(`
				CREATE FUNCTION public.${functionName}() RETURNS trigger
				LANGUAGE plpgsql AS $$
				BEGIN
					IF NEW.original_url = 'http://127.0.0.1:18080/f/${slug}' THEN
						RAISE EXCEPTION 'intentional form link persistence failure';
					END IF;
					RETURN NEW;
				END;
				$$
			`);
			await migrationPool.query(`
				CREATE TRIGGER ${triggerName}
				BEFORE INSERT ON public.links
				FOR EACH ROW EXECUTE FUNCTION public.${functionName}()
			`);
			let publishFailed = false;
			try {
				await service.publish(
					ownerId,
					created!.form.id,
					slug,
					"http://127.0.0.1:18080",
					"http://127.0.0.1:18080",
					"public",
				);
			} catch (error) {
				publishFailed = true;
				expect(nestedPostgresCode(error)).toBe("P0001");
			}
			expect(publishFailed).toBe(true);
		} finally {
			await migrationPool.query(
				`DROP TRIGGER IF EXISTS ${triggerName} ON public.links`,
			);
			await migrationPool.query(
				`DROP FUNCTION IF EXISTS public.${functionName}()`,
			);
			await migrationPool.end();
		}

		const [form] = await db
			.select({ slug: forms.slug, shortCode: forms.shortCode })
			.from(forms)
			.where(eq(forms.id, created!.form.id))
			.limit(1);
		const [version] = await db
			.select({ publishedAt: formVersions.publishedAt })
			.from(formVersions)
			.where(eq(formVersions.formId, created!.form.id))
			.limit(1);
		const aliases = await db
			.select()
			.from(formAliases)
			.where(eq(formAliases.formId, created!.form.id));
		expect(form).toEqual({ slug: null, shortCode: null });
		expect(version?.publishedAt).toBeNull();
		expect(aliases).toHaveLength(0);
	});

	it("keeps concurrent and sequential republishing on one stable alias and short link", async () => {
		const ownerId = await createOwner(db, owners);
		const created = await service.create(
			ownerId,
			definition("Republish stable"),
		);
		const slug = runSlug("republish-stable");
		const simultaneous = await Promise.allSettled([
			service.publish(
				ownerId,
				created!.form.id,
				slug,
				"https://forms.test",
				"https://short.test",
				"public",
			),
			service.publish(
				ownerId,
				created!.form.id,
				slug,
				"https://forms.test",
				"https://short.test",
				"public",
			),
		]);
		expect(
			simultaneous.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			simultaneous.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const concurrentFailure = simultaneous.find(
			(result) => result.status === "rejected",
		);
		expect(concurrentFailure).toMatchObject({ reason: expect.any(FormsError) });
		const initial = simultaneous.find(
			(result) => result.status === "fulfilled",
		)!;
		if (initial.status !== "fulfilled")
			throw new Error("Expected one publish to succeed");
		const repeated = await service.publish(
			ownerId,
			created!.form.id,
			"",
			"https://forms.test",
			"https://short.test",
			"public",
		);
		expect(repeated?.form.shortCode).toBe(initial.value?.form.shortCode);
		const aliases = await db
			.select()
			.from(formAliases)
			.where(eq(formAliases.formId, created!.form.id));
		expect(aliases.map((alias) => alias.alias)).toEqual([slug]);
		const storedLinks = await db
			.select()
			.from(links)
			.where(eq(links.shortCode, repeated!.form.shortCode!));
		expect(storedLinks).toHaveLength(1);
	});

	it("keeps trigger idempotency and monthly accounting correct across a UTC month boundary", async () => {
		const ownerId = await createOwner(db, owners);
		let now = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
		const timezonePool = createPgPool(testDatabaseUrl!, {
			max: 1,
			options: "-c timezone=Pacific/Honolulu",
		});
		const timezoneDb = createPgDb(timezonePool);
		const timezoneService = new FormsService(timezoneDb, () => now);

		try {
			const timezoneResult = await timezonePool.query<{ timezone: string }>(
				"SELECT current_setting('TimeZone') AS timezone",
			);
			expect(timezoneResult.rows[0]?.timezone).toBe("Pacific/Honolulu");

			const created = await timezoneService.create(
				ownerId,
				definition("UTC month boundary"),
			);
			const published = await timezoneService.publish(
				ownerId,
				created!.form.id,
				runSlug("utc-month-boundary"),
				"https://forms.test",
				"https://short.test",
				"public",
			);
			const formId = created!.form.id;
			const versionId = published!.publishedVersion!.id;
			const octoberTimestamp = now;
			const first = await timezoneService.acceptResponse(
				formId,
				versionId,
				"same-response-key",
				{ name: "October" },
			);

			// This exercises the SQL conflict path directly: BEFORE INSERT triggers run
			// even when ON CONFLICT later skips the duplicate row.
			await timezonePool.query(
				`INSERT INTO public.form_responses
					(id, form_id, version_id, idempotency_key, answers_json, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (form_id, idempotency_key) DO NOTHING`,
				[
					crypto.randomUUID(),
					formId,
					versionId,
					"same-response-key",
					JSON.stringify({ name: "duplicate" }),
					octoberTimestamp,
				],
			);
			const [afterDuplicate] = await timezoneDb
				.select()
				.from(formMonthlyUsage)
				.where(eq(formMonthlyUsage.ownerId, ownerId));
			expect(afterDuplicate).toMatchObject({
				month: "2026-10",
				responseCount: 1,
			});
			const {
				rows: [responseCount],
			} = await timezonePool.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM public.form_responses WHERE form_id = $1",
				[formId],
			);
			expect(responseCount?.count).toBe("1");
			expect(first.duplicate).toBe(false);

			now += 1;
			await timezoneService.acceptResponse(formId, versionId, "november-key", {
				name: "November",
			});
			const usageRows = await timezoneDb
				.select()
				.from(formMonthlyUsage)
				.where(eq(formMonthlyUsage.ownerId, ownerId));
			expect(usageRows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ month: "2026-10", responseCount: 1 }),
					expect.objectContaining({ month: "2026-11", responseCount: 1 }),
				]),
			);
		} finally {
			await timezonePool.end();
		}
	});

	it("applies the monthly quota to accepted rows in a multi-row insert and rolls back retention", async () => {
		if (!migratorDatabaseUrl) throw new Error("Test migrator URL is missing");
		const migratorPool = createPgPool(migratorDatabaseUrl, { max: 1 });
		let originalLimits:
			| {
					max_monthly_responses: number;
					max_retained_responses: number;
			  }
			| undefined;
		try {
			const limitsResult = await migratorPool.query<{
				max_monthly_responses: number;
				max_retained_responses: number;
			}>(
				"SELECT max_monthly_responses, max_retained_responses FROM public.form_limits WHERE id = 1",
			);
			originalLimits = limitsResult.rows[0];
			if (!originalLimits) throw new Error("Form limits row is missing");

			await migratorPool.query(
				"UPDATE public.form_limits SET max_monthly_responses = 1, max_retained_responses = 1 WHERE id = 1",
			);
			const ownerId = await createOwner(db, owners);
			let now = Date.UTC(2026, 8, 30, 23, 59, 59, 999);
			const quotaService = new FormsService(db, () => now);
			const created = await quotaService.create(
				ownerId,
				definition("Statement quota"),
			);
			if (!created) throw new Error("Form creation failed");
			const published = await quotaService.publish(
				ownerId,
				created.form.id,
				runSlug("statement-quota"),
				"https://forms.test",
				"https://short.test",
				"public",
			);
			if (!published?.publishedVersion)
				throw new Error("Form publication failed");
			const formId = created.form.id;
			const versionId = published.publishedVersion.id;
			const retained = await quotaService.acceptResponse(
				formId,
				versionId,
				"retained-seed",
				{ name: "Keep if bulk insert fails" },
			);
			now = Date.UTC(2026, 9, 1, 0, 0, 0, 0);

			const insertBulkRows = (keys: [string, string]) =>
				pool.query(
					`INSERT INTO public.form_responses
						(id, form_id, version_id, idempotency_key, answers_json, created_at)
					 VALUES ($1, $2, $3, $4, '{}', $5), ($6, $2, $3, $7, '{}', $5)
					 ON CONFLICT (form_id, idempotency_key) DO NOTHING`,
					[
						crypto.randomUUID(),
						formId,
						versionId,
						keys[0],
						now,
						crypto.randomUUID(),
						keys[1],
					],
				);

			await expect(
				insertBulkRows(["bulk-over-limit-a", "bulk-over-limit-b"]),
			).rejects.toMatchObject({
				code: "P0001",
				message: expect.stringContaining("forms_owner_monthly_quota"),
			});
			const afterRejectedBulk = await db
				.select()
				.from(formResponses)
				.where(eq(formResponses.formId, formId));
			expect(afterRejectedBulk.map((row) => row.id)).toEqual([
				retained.responseId,
			]);
			const afterRejectedUsage = await db
				.select()
				.from(formMonthlyUsage)
				.where(eq(formMonthlyUsage.ownerId, ownerId));
			expect(afterRejectedUsage).toEqual([
				expect.objectContaining({ month: "2026-09", responseCount: 1 }),
			]);

			const acceptedId = crypto.randomUUID();
			await pool.query(
				`INSERT INTO public.form_responses
				(id, form_id, version_id, idempotency_key, answers_json, created_at)
			 VALUES ($1, $2, $3, 'retained-seed', '{}', $4),
				($5, $2, $3, 'one-new-accepted', '{}', $4)
			 ON CONFLICT (form_id, idempotency_key) DO NOTHING`,
				[crypto.randomUUID(), formId, versionId, now, acceptedId],
			);
			const acceptedRows = await db
				.select()
				.from(formResponses)
				.where(eq(formResponses.formId, formId));
			expect(acceptedRows.map((row) => row.id)).toEqual([acceptedId]);
			const acceptedUsage = await db
				.select()
				.from(formMonthlyUsage)
				.where(eq(formMonthlyUsage.ownerId, ownerId));
			expect(acceptedUsage).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ month: "2026-09", responseCount: 1 }),
					expect.objectContaining({ month: "2026-10", responseCount: 1 }),
				]),
			);
		} finally {
			if (originalLimits)
				await migratorPool.query(
					"UPDATE public.form_limits SET max_monthly_responses = $1, max_retained_responses = $2 WHERE id = 1",
					[
						originalLimits.max_monthly_responses,
						originalLimits.max_retained_responses,
					],
				);
			await migratorPool.end();
		}
	});

	it("serializes concurrent publications against the per-owner cap", async () => {
		const ownerId = await createOwner(db, owners);
		const now = Date.now();
		const seededForms = Array.from({ length: 27 }, (_, index) => ({
			id: crypto.randomUUID(),
			ownerId,
			title: `Form ${index}`,
			description: null,
			theme: "light",
			accent: "blue",
			confirmationMessage: null,
			slug: null,
			shortCode: null,
			createdAt: now,
			updatedAt: now,
			disabledAt: null,
		}));
		await db.insert(forms).values(seededForms);
		await db.insert(formVersions).values(
			seededForms.map((form, index) => ({
				id: crypto.randomUUID(),
				formId: form.id,
				version: 1,
				fieldsJson: JSON.stringify(definition(form.title).fields),
				title: form.title,
				description: null,
				confirmationMessage: null,
				accent: "blue",
				respondentAccess: "public",
				createdAt: now,
				publishedAt: index < 24 ? now : null,
			})),
		);
		const contenders = seededForms.slice(25);
		const outcomes = await Promise.allSettled([
			service.publish(
				ownerId,
				contenders[0]!.id,
				runSlug("last-form-a"),
				"https://forms.test",
				"https://short.test",
				"public",
			),
			service.publish(
				ownerId,
				contenders[1]!.id,
				runSlug("last-form-b"),
				"https://forms.test",
				"https://short.test",
				"public",
			),
		]);
		expect(
			outcomes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const rejected = outcomes.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({ reason: expect.any(FormsError) });
		const publishedCount = await pool.query<{ count: string }>(
			`SELECT count(DISTINCT f.id)::text AS count
			 FROM public.forms f
			 JOIN public.form_versions v ON v.form_id = f.id
			 WHERE f.owner_id = $1 AND f.disabled_at IS NULL AND v.published_at IS NOT NULL`,
			[ownerId],
		);
		expect(publishedCount.rows[0]?.count).toBe("25");
	}, 60_000);

	it("reserves aliases globally and preserves deleted aliases as tombstones", async () => {
		const firstOwner = await createOwner(db, owners);
		const secondOwner = await createOwner(db, owners);
		const first = await service.create(firstOwner, definition("First"));
		const second = await service.create(secondOwner, definition("Second"));
		const alias = runSlug("stable-address");
		await service.setSlug(firstOwner, first!.form.id, alias);
		await expect(
			service.setSlug(secondOwner, second!.form.id, alias),
		).rejects.toMatchObject({ code: "SLUG_TAKEN" });
		await service.delete(firstOwner, first!.form.id);
		await expect(
			service.setSlug(secondOwner, second!.form.id, alias),
		).rejects.toMatchObject({ code: "SLUG_TAKEN" });
	});

	it("serializes alias claims and concurrent submit/delete operations without deadlock", async () => {
		const firstOwner = await createOwner(db, owners);
		const secondOwner = await createOwner(db, owners);
		const first = await service.create(
			firstOwner,
			definition("First contender"),
		);
		const second = await service.create(
			secondOwner,
			definition("Second contender"),
		);
		const sharedAlias = runSlug("one-winner");
		const claims = await Promise.allSettled([
			service.setSlug(firstOwner, first!.form.id, sharedAlias),
			service.setSlug(secondOwner, second!.form.id, sharedAlias),
		]);
		expect(
			claims.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			claims.filter((result) => result.status === "rejected"),
		).toHaveLength(1);

		const published = await service.publish(
			firstOwner,
			first!.form.id,
			undefined,
			"https://forms.test",
			"https://short.test",
			"public",
		);
		const submissionId = crypto.randomUUID();
		const raced = await Promise.allSettled([
			service.acceptResponse(
				first!.form.id,
				published!.publishedVersion!.id,
				"submit-delete-race",
				{ name: "Ava" },
			),
			service.deleteResponse(firstOwner, first!.form.id),
			service.setSlug(
				firstOwner,
				first!.form.id,
				`new-${submissionId.slice(0, 8)}`,
			),
		]);
		expect(raced.every((result) => result.status === "fulfilled")).toBe(true);
	}, 10_000);

	it("keeps form versions and their snapshots atomic during revision saves", async () => {
		const ownerId = await createOwner(db, owners);
		const created = await service.create(ownerId, definition("Revision 1"));
		const saved = await service.save(
			ownerId,
			created!.form.id,
			definition("Revision 2"),
			1,
		);
		expect(saved?.revision).toBe(2);
		const [latest] = await db
			.select()
			.from(formVersions)
			.where(
				and(
					eq(formVersions.formId, created!.form.id),
					eq(formVersions.version, 2),
				),
			);
		expect(latest?.title).toBe("Revision 2");
	});

	it("paginates matching forms with a stable Unicode-search cursor", async () => {
		const ownerId = await createOwner(db, owners);
		for (const title of ["東京 one", "東京 two", "東京 three", "Other"])
			await service.create(ownerId, definition(title));
		const firstPage = await service.list(ownerId, { limit: 2, search: "東京" });
		expect(firstPage.forms).toHaveLength(2);
		expect(firstPage.totalForms).toBe(3);
		expect(firstPage.usage.forms).toBe(4);
		expect(firstPage.nextCursor).toEqual(expect.any(String));
		const secondPage = await service.list(ownerId, {
			limit: 2,
			search: "東京",
			cursor: firstPage.nextCursor ?? undefined,
		});
		expect(secondPage.forms).toHaveLength(1);
		expect(secondPage.nextCursor).toBeNull();
		expect(
			[...firstPage.forms, ...secondPage.forms].map((form) => form.title),
		).toEqual(expect.arrayContaining(["東京 one", "東京 two", "東京 three"]));
	});

	it("streams export pages in timestamp-tie order and fences later responses", async () => {
		const ownerId = await createOwner(db, owners);
		const created = await service.create(ownerId, definition("Export paging"));
		const published = await service.publish(
			ownerId,
			created!.form.id,
			runSlug("export-paging"),
			"https://forms.test",
			"https://short.test",
			"public",
		);
		const createdAt = Date.now();
		const originalRows = Array.from({ length: 5 }, (_, index) => ({
			id: `export-${runNamespace}-row-${index}`,
			formId: created!.form.id,
			versionId: published!.publishedVersion!.id,
			idempotencyKey: `export-key-${index}`,
			answersJson: JSON.stringify({ name: `Row ${index}` }),
			createdAt,
		}));
		await db.insert(formResponses).values(originalRows);
		const pages = await service.exportRowsInPages(ownerId, created!.form.id, 2);
		if (!pages) throw new Error("Expected the form to be exportable");
		const iterator = pages[Symbol.asyncIterator]();
		const firstPage = await iterator.next();
		expect(firstPage.value).toHaveLength(2);
		await db.insert(formResponses).values({
			id: `newer-${runNamespace}-export-row`,
			formId: created!.form.id,
			versionId: published!.publishedVersion!.id,
			idempotencyKey: "newer-export-key",
			answersJson: JSON.stringify({ name: "Later" }),
			createdAt: createdAt + 1,
		});
		const exported = [...firstPage.value];
		for (;;) {
			const page = await iterator.next();
			if (page.done) break;
			exported.push(...page.value);
		}
		expect(exported.map((row) => row.id)).toEqual(
			originalRows.map((row) => row.id).sort(),
		);
	});

	it("allows a blank draft but rejects publishing until it has a question", async () => {
		const ownerId = await createOwner(db, owners);
		const created = await service.create(ownerId, {
			title: "Blank draft",
			accent: "blue",
			fields: [],
		});
		expect(created?.draft?.fields).toEqual([]);
		await expect(
			service.publish(
				ownerId,
				created!.form.id,
				undefined,
				"https://forms.test",
				"https://short.test",
				"public",
			),
		).rejects.toMatchObject({ code: "NO_QUESTIONS" });
	});

	it("rejects overlapping draft revisions and changes respondent access only on a new published version", async () => {
		const ownerId = await createOwner(db, owners);
		const created = await service.create(ownerId, definition("Initial"));
		const concurrentSaves = await Promise.allSettled([
			service.save(ownerId, created!.form.id, definition("Change A"), 1),
			service.save(ownerId, created!.form.id, definition("Change B"), 1),
		]);
		expect(
			concurrentSaves.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const conflict = concurrentSaves.find(
			(result) => result.status === "rejected",
		);
		expect(conflict).toMatchObject({ reason: { code: "REVISION_CONFLICT" } });

		const firstPublished = await service.publish(
			ownerId,
			created!.form.id,
			runSlug("access-snapshot"),
			"https://forms.test",
			"https://short.test",
			"verified_email",
		);
		const historicalId = firstPublished!.publishedVersion!.id;
		const saved = await service.save(
			ownerId,
			created!.form.id,
			definition("After private publication"),
			firstPublished!.revision,
		);
		const secondPublished = await service.publish(
			ownerId,
			created!.form.id,
			undefined,
			"https://forms.test",
			"https://short.test",
			"public",
		);
		expect(saved?.revision).toBe(firstPublished!.revision + 1);
		expect(
			(await service.getVersion(created!.form.id, historicalId))
				?.respondentAccess,
		).toBe("verified_email");
		expect(secondPublished?.publishedVersion?.respondentAccess).toBe("public");
	});

	it("aggregates every retained answer past the response page and deduplicates legacy multichoice values", async () => {
		const ownerId = await createOwner(db, owners);
		const created = await service.create(
			ownerId,
			choiceDefinition("All responses"),
		);
		const published = await service.publish(
			ownerId,
			created!.form.id,
			runSlug("all-responses"),
			"https://forms.test",
			"https://short.test",
			"public",
		);
		const now = Date.now();
		const rows = Array.from({ length: 502 }, (_, index) => ({
			id: crypto.randomUUID(),
			formId: created!.form.id,
			versionId: published!.publishedVersion!.id,
			idempotencyKey: `stats-${index}`,
			answersJson: JSON.stringify({
				choices: index === 0 ? ["A", "A"] : ["A"],
			}),
			createdAt: index === 0 ? now - 7 * 24 * 60 * 60 * 1000 - 1 : now,
		}));
		for (let start = 0; start < rows.length; start += 50)
			await db.insert(formResponses).values(rows.slice(start, start + 50));

		const result = await service.responses(ownerId, created!.form.id, 100);
		const question = result?.stats[0]?.questions[0];
		expect(result?.total).toBe(502);
		expect(result?.last7Days).toBe(501);
		expect(result?.responses).toHaveLength(100);
		expect(question).toMatchObject({
			answered: 502,
			distribution: { A: 502 },
			options: ["A", "B"],
		});
	});
});

async function createOwner(db: UrlxDb, owners: Set<string>) {
	const id = crypto.randomUUID();
	const now = new Date();
	await db.insert(authUser).values({
		id,
		name: "Integration Test",
		email: `forms-${id}@example.test`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now,
	});
	owners.add(id);
	return id;
}

function nestedPostgresCode(error: unknown) {
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && !seen.has(current)) {
		seen.add(current);
		if (
			typeof current === "object" &&
			"code" in current &&
			typeof (current as { code?: unknown }).code === "string"
		)
			return (current as { code: string }).code;
		current =
			typeof current === "object" && "cause" in current
				? (current as { cause?: unknown }).cause
				: null;
	}
	return null;
}

function definition(title: string) {
	return {
		title,
		accent: "blue" as const,
		fields: [
			{
				id: "name",
				type: "short" as const,
				label: "Name",
				required: true,
			},
		],
	};
}

function choiceDefinition(title: string) {
	return {
		title,
		accent: "blue" as const,
		fields: [
			{
				id: "choices",
				type: "multichoice" as const,
				label: "Choices",
				required: false,
				options: ["A", "B"],
			},
		],
	};
}

function runSlug(value: string) {
	return `${runNamespace}-${value}`;
}

async function assertPoolIdentity(
	pool: UrlxDbPool,
	expected: "urlx_app" | "urlx_migrator",
) {
	const { rows } = await pool.query<DatabaseRoleIdentity>(`
		SELECT current_user AS role,
			session_user AS "sessionRole",
			roles.rolsuper AS superuser,
			roles.rolcreaterole AS "createRole",
			roles.rolcreatedb AS "createDatabase",
			roles.rolreplication AS replication,
			roles.rolbypassrls AS "bypassRls",
			has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabase",
			has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreatePublicSchema"
		FROM pg_catalog.pg_roles AS roles
		WHERE roles.rolname = current_user
	`);
	const identity = rows[0];
	if (!identity) throw new Error("Unable to validate the PostgreSQL test role");
	assertDatabaseIdentity(identity, expected);
}
