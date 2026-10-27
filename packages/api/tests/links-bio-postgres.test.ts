import { fileURLToPath, URL } from "node:url";
import {
	assertDatabaseIdentity,
	bioLinks,
	bioPages,
	createPgDb,
	createPgPool,
	type DatabaseRoleIdentity,
	links,
	type UrlxDb,
	type UrlxDbPool,
} from "@urlx/db";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BioRepository } from "../src/modules/bio/bio.repository";
import { BioService } from "../src/modules/bio/bio.service";
import { LinkService } from "../src/modules/links/link.service";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const migratorDatabaseUrl = process.env.TEST_MIGRATOR_DATABASE_URL;

describe("links and bio PostgreSQL integration", () => {
	let pool!: UrlxDbPool;
	let db!: UrlxDb;
	let migratorPool!: UrlxDbPool;
	let linksService!: LinkService;
	let bioService!: BioService;
	const originalUrls = new Set<string>();
	const bioSlugs = new Set<string>();

	beforeAll(async () => {
		if (!testDatabaseUrl || !migratorDatabaseUrl) {
			throw new Error(
				"Set TEST_DATABASE_URL (urlx_app) and TEST_MIGRATOR_DATABASE_URL (urlx_migrator) to run PostgreSQL integration tests.",
			);
		}
		migratorPool = createPgPool(migratorDatabaseUrl, { max: 1 });
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
		linksService = new LinkService({
			db,
			shortUrlBase: "https://short.test",
		});
		bioService = new BioService({ db });
	});

	afterAll(async () => {
		if (!testDatabaseUrl || !migratorDatabaseUrl || !pool) return;
		const cleanupPool = createPgPool(migratorDatabaseUrl, { max: 1 });
		try {
			const cleanupDb = createPgDb(cleanupPool);
			if (originalUrls.size) {
				await cleanupDb
					.delete(links)
					.where(inArray(links.originalUrl, [...originalUrls]));
			}
			if (bioSlugs.size) {
				const pages = await cleanupDb
					.select({ id: bioPages.id })
					.from(bioPages)
					.where(inArray(bioPages.slug, [...bioSlugs]));
				const pageIds = pages.map((page) => page.id);
				if (pageIds.length)
					await cleanupDb
						.delete(bioLinks)
						.where(inArray(bioLinks.pageId, pageIds));
				await cleanupDb
					.delete(bioPages)
					.where(inArray(bioPages.slug, [...bioSlugs]));
			}
		} finally {
			await cleanupPool.end();
			await pool.end();
		}
	});

	it("deduplicates concurrent identical URLs and uses indexed short-code reads with revocation", async () => {
		const originalUrl = `https://links.test/${crypto.randomUUID()}`;
		originalUrls.add(originalUrl);
		const results = await Promise.all(
			Array.from({ length: 8 }, () => linksService.shorten(originalUrl)),
		);
		expect(new Set(results.map((result) => result.shortCode)).size).toBe(1);
		expect(new Set(results.map((result) => result.shortUrl)).size).toBe(1);

		const code = results[0]?.shortCode;
		if (!code) throw new Error("Shortener did not return a code");
		expect(await linksService.getByShortCode(code)).toEqual({ originalUrl });
		const index = await pool.query<{ indexdef: string }>(
			"SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'links' AND indexname = 'links_short_code_unique'",
		);
		expect(index.rows[0]?.indexdef).toContain("short_code");

		await expect(
			pool.query("DELETE FROM public.links WHERE short_code = $1", [code]),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			pool.query(
				"UPDATE public.links SET disabled_at = $1 WHERE short_code = $2",
				[Date.now(), code],
			),
		).rejects.toMatchObject({ code: "42501" });
		const revokedAt = Date.now();
		const revocationPool = createPgPool(requireMigratorDatabaseUrl(), {
			max: 1,
		});
		try {
			await revocationPool.query(
				"UPDATE public.links SET disabled_at = $1 WHERE short_code = $2",
				[revokedAt, code],
			);
		} finally {
			await revocationPool.end();
		}
		await expect(linksService.getByShortCode(code)).rejects.toMatchObject({
			code: "SHORT_CODE_NOT_FOUND",
		});
	});

	it("creates and reads a Bio page, rejects slug collisions, and hides disabled/deleted pages", async () => {
		const slug = uniqueSlug();
		bioSlugs.add(slug);
		const created = await bioService.createBioPage({
			title: "Integration page",
			description: "PostgreSQL persistence",
			slug,
			links: [
				{ label: "Second", url: "https://bio.test/second" },
				{ label: "First", url: "https://bio.test/first" },
			],
		});
		expect(created).toEqual({ slug });
		expect(await bioService.getBioPage(slug)).toEqual({
			slug,
			title: "Integration page",
			description: "PostgreSQL persistence",
			links: [
				{ label: "Second", url: "https://bio.test/second" },
				{ label: "First", url: "https://bio.test/first" },
			],
		});
		await expect(
			bioService.createBioPage({
				title: "Collision",
				slug,
				links: [{ label: "Link", url: "https://bio.test/collision" }],
			}),
		).rejects.toMatchObject({ code: "SLUG_TAKEN" });

		const [page] = await db
			.select({ id: bioPages.id })
			.from(bioPages)
			.where(eq(bioPages.slug, slug));
		if (!page) throw new Error("Bio page was not persisted");
		const pageLinks = await db
			.select({ id: bioLinks.id })
			.from(bioLinks)
			.where(eq(bioLinks.pageId, page.id));
		await expect(
			pool.query("DELETE FROM public.bio_pages WHERE id = $1", [page.id]),
		).rejects.toMatchObject({ code: "42501" });
		const deletionPool = createPgPool(requireMigratorDatabaseUrl(), {
			max: 1,
		});
		try {
			await deletionPool.query(
				"UPDATE public.bio_pages SET disabled_at = $1 WHERE id = $2",
				[Date.now(), page.id],
			);
			await expect(bioService.getBioPage(slug)).rejects.toMatchObject({
				code: "PAGE_NOT_FOUND",
			});
			await deletionPool.query(
				"DELETE FROM public.bio_links WHERE page_id = $1",
				[page.id],
			);
			await deletionPool.query("DELETE FROM public.bio_pages WHERE id = $1", [
				page.id,
			]);
		} finally {
			await deletionPool.end();
		}
		const remaining = await db
			.select({ id: bioLinks.id })
			.from(bioLinks)
			.where(eq(bioLinks.pageId, page.id));
		expect(pageLinks).toHaveLength(2);
		expect(remaining).toHaveLength(0);
		await expect(bioService.getBioPage(slug)).rejects.toMatchObject({
			code: "PAGE_NOT_FOUND",
		});
	});

	it("rolls back the Bio page when child-link insertion fails", async () => {
		const pageId = crypto.randomUUID();
		const slug = uniqueSlug();
		const now = Date.now();
		const repository = new BioRepository(db);
		await expect(
			repository.createPageWithLinks(
				{
					id: pageId,
					slug,
					title: "Must roll back",
					description: null,
					createdAt: now,
					updatedAt: now,
					disabledAt: null,
				},
				[
					{
						id: "duplicate-child-id",
						pageId,
						label: "First",
						url: "https://bio.test/first",
						position: 0,
						createdAt: now,
					},
					{
						id: "duplicate-child-id",
						pageId,
						label: "Second",
						url: "https://bio.test/second",
						position: 1,
						createdAt: now,
					},
				],
			),
		).rejects.toMatchObject({ cause: { code: "23505" } });
		const page = await db
			.select({ id: bioPages.id })
			.from(bioPages)
			.where(eq(bioPages.id, pageId));
		const childLinks = await db
			.select({ id: bioLinks.id })
			.from(bioLinks)
			.where(eq(bioLinks.pageId, pageId));
		expect(page).toHaveLength(0);
		expect(childLinks).toHaveLength(0);
	});
});

function uniqueSlug() {
	return `it-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function requireMigratorDatabaseUrl() {
	if (!migratorDatabaseUrl)
		throw new Error("TEST_MIGRATOR_DATABASE_URL is required");
	return migratorDatabaseUrl;
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
