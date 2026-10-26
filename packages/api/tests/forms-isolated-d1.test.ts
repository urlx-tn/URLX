import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@urlx/db";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type FormExportRow,
	FormsService,
} from "../src/modules/forms/forms.service";

const owner = "synthetic-owner";
// Publishing requires at least one question; most lifecycle tests only need a placeholder.
const sampleFields = [
	{ id: "q", type: "short" as const, label: "Question", required: false },
];
const testDirectory = dirname(fileURLToPath(import.meta.url));
let mf: Miniflare;
let service: FormsService;
type TestD1 = NonNullable<Parameters<typeof createDb>[0]>;

function createCountedService(d1: TestD1, now = () => Date.now()) {
	let preparedQueries = 0;
	const countedD1 = new Proxy(d1, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (property === "prepare") {
				return (...args: Parameters<typeof target.prepare>) => {
					preparedQueries += 1;
					return target.prepare(...args);
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		service: new FormsService(createDb(countedD1), now),
		get preparedQueries() {
			return preparedQueries;
		},
		reset() {
			preparedQueries = 0;
		},
	};
}

async function addTestOwner(id: string, email: string) {
	const d1 = await mf.getD1Database("DB");
	await d1
		.prepare(
			"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Synthetic', ?, 1, 1, 1)",
		)
		.bind(id, email)
		.run();
	return d1;
}

beforeAll(async () => {
	mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('ok') } }",
		compatibilityDate: "2026-05-01",
		d1Databases: ["DB"],
	});
	const d1 = await mf.getD1Database("DB");
	const names = [
		"0000_faulty_iron_patriot.sql",
		"0001_handy_shocker.sql",
		"0002_forms_auth.sql",
		"0003_respondent_access.sql",
	];
	for (const name of names) {
		const sql = await readFile(
			resolve(testDirectory, `../../db/src/migrations/${name}`),
			"utf8",
		);
		for (const statement of sql
			.split("--> statement-breakpoint")
			.map((part) => part.trim())
			.filter(Boolean))
			await d1.prepare(statement).run();
	}
	const db = createDb(d1);
	await d1
		.prepare(
			"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Synthetic', 'synthetic@example.invalid', 1, 1, 1)",
		)
		.bind(owner)
		.run();
	service = new FormsService(db, () => Date.UTC(2026, 9, 16));
}, 30_000);

afterAll(async () => {
	await mf?.dispose();
});

describe("forms isolated D1 lifecycle", () => {
	it("lists multiple forms with a bounded number of prepared queries", async () => {
		const ownerId = "synthetic-batched-list-owner";
		const d1 = await addTestOwner(ownerId, "batched-list@example.invalid");
		const setup = new FormsService(createDb(d1), () => Date.UTC(2026, 9, 16));
		const live = await setup.create(ownerId, {
			title: "Live form",
			accent: "blue",
			fields: sampleFields,
		});
		const published = await setup.publish(
			ownerId,
			live!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		await setup.acceptResponse(live!.form!.id, published!.version, "list-one", {
			q: "Answer",
		});
		for (const title of ["Draft two", "Draft three", "Draft four"]) {
			await setup.create(ownerId, {
				title,
				accent: "teal",
				fields: sampleFields,
			});
		}

		const counted = createCountedService(d1);
		const listed = await counted.service.list(ownerId);

		expect(counted.preparedQueries).toBe(6);
		expect(listed.forms).toHaveLength(4);
		expect(listed.totalForms).toBe(4);
		expect(listed.usage.forms).toBe(4);
		expect(
			listed.forms.find((form) => form.id === live!.form!.id),
		).toMatchObject({
			responseCount: 1,
			publishedVersion: {
				id: published!.version,
				title: "Live form",
				fields: sampleFields,
			},
		});
		expect(
			listed.forms
				.filter((form) => form.id !== live!.form!.id)
				.every(
					(form) => form.responseCount === 0 && form.publishedVersion === null,
				),
		).toBe(true);

		const firstPage = await counted.service.list(ownerId, { limit: 2 });
		const secondPage = await counted.service.list(ownerId, {
			limit: 2,
			cursor: firstPage.nextCursor ?? undefined,
		});
		expect(firstPage.forms).toHaveLength(2);
		expect(firstPage.nextCursor).toBeTruthy();
		expect(secondPage.forms).toHaveLength(2);
		expect(secondPage.nextCursor).toBeNull();
		expect(
			[...firstPage.forms, ...secondPage.forms].map((form) => form.id),
		).toEqual(
			listed.forms
				.slice()
				.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
				.map((form) => form.id),
		);
		const searched = await counted.service.list(ownerId, {
			search: "LIVE FORM",
		});
		expect(searched.forms.map((form) => form.id)).toEqual([live!.form!.id]);
		expect(searched.totalForms).toBe(1);
		expect(searched.usage.forms).toBe(4);
		await expect(
			counted.service.list(ownerId, {
				search: "different search",
				cursor: searched.nextCursor ?? "invalid",
			}),
		).rejects.toMatchObject({ code: "INVALID_CURSOR" });
	});

	it("encodes Unicode search terms in paged list cursors", async () => {
		const ownerId = "synthetic-unicode-list-owner";
		const d1 = await addTestOwner(ownerId, "unicode-list@example.invalid");
		const setup = new FormsService(createDb(d1));
		await setup.create(ownerId, {
			title: "東京の登録",
			accent: "blue",
			fields: sampleFields,
		});
		await setup.create(ownerId, {
			title: "東京の申込み",
			accent: "teal",
			fields: sampleFields,
		});

		const first = await setup.list(ownerId, { limit: 1, search: "東京" });
		const second = await setup.list(ownerId, {
			limit: 1,
			search: "東京",
			cursor: first.nextCursor ?? undefined,
		});

		expect(first.forms).toHaveLength(1);
		expect(first.nextCursor).toBeTruthy();
		expect(second.forms).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
	});

	it("batches list details with a full 100-form page", async () => {
		const ownerId = "synthetic-hundred-form-owner";
		const d1 = await addTestOwner(ownerId, "hundred-form@example.invalid");
		const createdAt = Date.UTC(2026, 9, 16);
		const statements = [];
		for (let index = 0; index < 100; index++) {
			const id = `synthetic-list-form-${String(index).padStart(3, "0")}`;
			statements.push(
				d1
					.prepare(
						"INSERT INTO forms (id,owner_id,title,theme,accent,created_at,updated_at) VALUES (?,?,?,'light','blue',?,?)",
					)
					.bind(id, ownerId, `Form ${index}`, createdAt, createdAt),
				d1
					.prepare(
						"INSERT INTO form_versions (id,form_id,version,fields_json,title,accent,created_at) VALUES (?,?,1,'[]',?,'blue',?)",
					)
					.bind(
						`synthetic-list-version-${index}`,
						id,
						`Form ${index}`,
						createdAt,
					),
			);
		}
		for (let start = 0; start < statements.length; start += 50)
			await d1.batch(statements.slice(start, start + 50));

		const counted = createCountedService(d1);
		const result = await counted.service.list(ownerId, { limit: 100 });

		expect(counted.preparedQueries).toBe(6);
		expect(result.forms).toHaveLength(100);
		expect(result.totalForms).toBe(100);
		expect(result.usage.forms).toBe(100);
		expect(result.nextCursor).toBeNull();
	});

	it("computes response stats with one answer read across published versions", async () => {
		const ownerId = "synthetic-batched-stats-owner";
		const d1 = await addTestOwner(ownerId, "batched-stats@example.invalid");
		await d1
			.prepare(
				"UPDATE form_limits SET max_published=25, max_monthly_responses=1000, max_retained_responses=10000 WHERE id=1",
			)
			.run();
		const setup = new FormsService(createDb(d1), () => Date.UTC(2026, 9, 16));
		const form = await setup.create(ownerId, {
			title: "Versioned stats",
			accent: "blue",
			fields: [
				{
					id: "choice",
					type: "singlechoice",
					label: "Choice",
					required: false,
					options: ["A", "B"],
				},
			],
		});
		const id = form!.form!.id;
		const publish = (respondentAccess: "public" = "public") =>
			setup.publish(
				ownerId,
				id,
				undefined,
				"https://forms.example.invalid",
				"https://s.example.invalid",
				respondentAccess,
			);
		const v1 = await publish();
		await setup.acceptResponse(id, v1!.version, "stats-v1", { choice: "A" });

		const secondDraft = await setup.save(
			ownerId,
			id,
			{
				title: "Versioned stats",
				accent: "blue",
				fields: [
					{ id: "rating", type: "rating", label: "Rating", required: false },
				],
			},
			v1!.revision,
		);
		const v2 = await publish();
		await setup.acceptResponse(id, v2!.version, "stats-v2", { rating: 4 });

		const thirdDraft = await setup.save(
			ownerId,
			id,
			{
				title: "Versioned stats",
				accent: "blue",
				fields: [
					{ id: "empty", type: "short", label: "No response", required: false },
				],
			},
			secondDraft!.revision,
		);
		await publish();

		await setup.save(
			ownerId,
			id,
			{
				title: "Versioned stats",
				accent: "blue",
				fields: [
					{
						id: "multi",
						type: "multichoice",
						label: "Multi",
						required: false,
						options: ["Red", "Blue"],
					},
				],
			},
			thirdDraft!.revision,
		);
		const v4 = await publish();
		await setup.acceptResponse(id, v4!.version, "stats-v4", {
			multi: ["Blue", "Red", "Blue"],
		});
		let latestPublished = v4;
		for (let attempt = 0; attempt < 5; attempt++)
			latestPublished = await publish();
		const currentDraft = await setup.save(
			ownerId,
			id,
			{
				title: "Versioned stats",
				accent: "blue",
				fields: [
					{
						id: "draft",
						type: "short",
						label: "Current draft",
						required: false,
					},
				],
			},
			latestPublished!.revision,
		);

		const counted = createCountedService(d1);
		const result = await counted.service.responses(ownerId, id);

		expect(counted.preparedQueries).toBe(7);
		expect(result?.stats).toHaveLength(5);
		expect(result?.stats.map((stat) => stat.version)).toEqual([
			1,
			2,
			4,
			latestPublished!.revision,
			currentDraft!.revision,
		]);
		expect(result?.stats.map((stat) => stat.responseCount)).toEqual([
			1, 1, 1, 0, 0,
		]);
		expect(result?.stats[0]?.questions[0]).toMatchObject({
			fieldId: "choice",
			answered: 1,
			distribution: { A: 1 },
		});
		expect(result?.stats[1]?.questions[0]).toMatchObject({
			fieldId: "rating",
			distribution: { "4": 1 },
			average: 4,
		});
		expect(result?.stats[2]?.questions[0]).toMatchObject({
			fieldId: "multi",
			answered: 1,
			distribution: { Blue: 1, Red: 1 },
		});
		expect(result?.stats[3]?.questions[0]).toMatchObject({
			fieldId: "multi",
			answered: 0,
			distribution: {},
		});
		expect(result?.stats[4]?.questions[0]).toMatchObject({
			fieldId: "draft",
			answered: 0,
		});
	});

	it("reports choice answer counts across more responses than the page size", async () => {
		const ownerId = "synthetic-stats-page-owner";
		const d1 = await addTestOwner(ownerId, "stats-page@example.invalid");
		await d1
			.prepare(
				"UPDATE form_limits SET max_published=25, max_monthly_responses=1000, max_retained_responses=10000 WHERE id=1",
			)
			.run();
		const setup = new FormsService(createDb(d1), () => Date.UTC(2026, 9, 16));
		const form = await setup.create(ownerId, {
			title: "Large response page",
			accent: "blue",
			fields: [
				{
					id: "choice",
					type: "singlechoice",
					label: "Choice",
					required: false,
					options: ["A", "B"],
				},
			],
		});
		const published = await setup.publish(
			ownerId,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		const formId = form!.form!.id;
		const weekAgo = Date.UTC(2026, 9, 16) - 7 * 24 * 60 * 60 * 1000;
		const inserts = Array.from({ length: 501 }, (_, index) =>
			d1
				.prepare(
					"INSERT INTO form_responses (id,form_id,version_id,idempotency_key,answers_json,created_at) VALUES (?,?,?,?,?,?)",
				)
				.bind(
					`synthetic-page-response-${index}`,
					formId,
					published!.version,
					`synthetic-page-key-${index}`,
					JSON.stringify({ choice: index % 2 === 0 ? "A" : "B" }),
					index === 0 ? weekAgo - 1 : weekAgo + index - 1,
				),
		);
		for (let start = 0; start < inserts.length; start += 50)
			await d1.batch(inserts.slice(start, start + 50));

		const counted = createCountedService(d1, () => Date.UTC(2026, 9, 16));
		const result = await counted.service.responses(ownerId, formId, 500, 0);

		expect(counted.preparedQueries).toBe(9);
		expect(result?.responses).toHaveLength(500);
		expect(result?.total).toBe(501);
		expect(result?.last7Days).toBe(500);
		expect(result?.stats[0]?.responseCount).toBe(501);
		expect(result?.stats[0]?.questions[0]).toMatchObject({
			fieldId: "choice",
			answered: 501,
			distribution: { A: 251, B: 250 },
		});
	});

	it("pages tied response timestamps and excludes later rows beyond the high-water tuple", async () => {
		const ownerId = "synthetic-export-pages-owner";
		const d1 = await addTestOwner(ownerId, "export-pages@example.invalid");
		await d1
			.prepare(
				"UPDATE form_limits SET max_published=25, max_monthly_responses=1000, max_retained_responses=10000 WHERE id=1",
			)
			.run();
		const setup = new FormsService(createDb(d1), () => Date.UTC(2026, 9, 16));
		const exportFields = Array.from({ length: 50 }, (_, index) => ({
			id: `q${index}`,
			type: "short" as const,
			label: `Question ${index}`,
			required: false,
		}));
		const form = await setup.create(ownerId, {
			title: "Paged export",
			accent: "blue",
			fields: exportFields,
		});
		const published = await setup.publish(
			ownerId,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		const formId = form!.form!.id;
		const createdAt = Date.UTC(2026, 9, 16);
		await d1.batch([
			d1
				.prepare(
					"INSERT INTO form_responses (id,form_id,version_id,idempotency_key,answers_json,created_at) VALUES (?,?,?,?,?,?)",
				)
				.bind("export-a", formId, published!.version, "key-a", "{}", createdAt),
			d1
				.prepare(
					"INSERT INTO form_responses (id,form_id,version_id,idempotency_key,answers_json,created_at) VALUES (?,?,?,?,?,?)",
				)
				.bind(
					"export-b",
					formId,
					published!.version,
					"key-b",
					JSON.stringify({ q0: "" }),
					createdAt,
				),
			d1
				.prepare(
					"INSERT INTO form_responses (id,form_id,version_id,idempotency_key,answers_json,created_at) VALUES (?,?,?,?,?,?)",
				)
				.bind(
					"export-c",
					formId,
					published!.version,
					"key-c",
					JSON.stringify({ q0: "Last" }),
					createdAt,
				),
		]);

		const counted = createCountedService(d1);
		const pages = await counted.service.exportRowsInPages(ownerId, formId, 2);
		expect(pages).not.toBeNull();
		const pageSizes: number[] = [];
		const exported: FormExportRow[] = [];
		const pageIterator = pages![Symbol.asyncIterator]();
		const firstPage = await pageIterator.next();
		expect(firstPage.done).toBe(false);
		if (!firstPage.done) {
			pageSizes.push(firstPage.value.length);
			exported.push(...firstPage.value);
		}
		await d1
			.prepare(
				"INSERT INTO form_responses (id,form_id,version_id,idempotency_key,answers_json,created_at) VALUES (?,?,?,?,?,?)",
			)
			.bind(
				"export-newer",
				formId,
				published!.version,
				"key-newer",
				JSON.stringify({ q0: "Newer" }),
				createdAt + 1,
			)
			.run();
		for await (const page of {
			[Symbol.asyncIterator]: () => pageIterator,
		}) {
			pageSizes.push(page.length);
			exported.push(...page);
		}

		expect(counted.preparedQueries).toBe(4);
		expect(pageSizes).toEqual([2, 1]);
		expect(exported.map((row) => row.id)).toEqual([
			"export-a",
			"export-b",
			"export-c",
		]);
		expect(exported.every((row) => row.version === 1)).toBe(true);
		expect(exported.every((row) => row.fields.length === 50)).toBe(true);
		expect(exported.every((row) => row.fields[0]?.label === "Question 0")).toBe(
			true,
		);
		expect(exported.map((row) => row.answers)).toEqual([
			{},
			{ q0: "" },
			{ q0: "Last" },
		]);
	});

	it("does not extend an empty export when responses arrive after it starts", async () => {
		const ownerId = "synthetic-empty-export-owner";
		const d1 = await addTestOwner(ownerId, "empty-export@example.invalid");
		await d1
			.prepare(
				"UPDATE form_limits SET max_published=25, max_monthly_responses=1000, max_retained_responses=10000 WHERE id=1",
			)
			.run();
		const setup = new FormsService(createDb(d1), () => Date.UTC(2026, 9, 16));
		const form = await setup.create(ownerId, {
			title: "Empty export",
			accent: "blue",
			fields: sampleFields,
		});
		const published = await setup.publish(
			ownerId,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);

		const counted = createCountedService(d1);
		const pages = await counted.service.exportRowsInPages(
			ownerId,
			form!.form!.id,
		);
		expect(pages).not.toBeNull();
		await setup.acceptResponse(
			form!.form!.id,
			published!.version,
			"arrived-after-export-start",
			{ q: "New response" },
		);

		const exported: FormExportRow[] = [];
		for await (const page of pages!) exported.push(...page);
		expect(counted.preparedQueries).toBe(2);
		expect(exported).toEqual([]);
	});

	it("saves a truly blank draft but refuses to publish it", async () => {
		const blank = await service.create(owner, {
			title: "Untitled form",
			description: "",
			accent: "blue",
			fields: [],
		});
		const id = blank!.form!.id;
		expect(blank!.draft!.fields).toEqual([]);
		await expect(
			service.publish(
				owner,
				id,
				undefined,
				"https://forms.example.invalid",
				"https://s.example.invalid",
				"public",
			),
		).rejects.toMatchObject({ code: "NO_QUESTIONS", status: 400 });
	});

	it("upgrades the old form version shape and keeps published content immutable", async () => {
		const first = await service.create(owner, {
			title: "Original",
			description: "Before",
			accent: "blue",
			confirmationMessage: "Thanks old",
			fields: [
				{ id: "q", type: "short", label: "Original question", required: true },
			],
		});
		const id = first!.form!.id;
		await service.setSlug(owner, id, "synthetic-form");
		const published = await service.publish(
			owner,
			id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		const v1 = published!.version;
		await service.save(
			owner,
			id,
			{
				title: "Changed draft",
				description: "After",
				accent: "pink",
				confirmationMessage: "Thanks new",
				fields: [
					{ id: "q2", type: "rating", label: "New question", required: true },
				],
			},
			1,
		);
		const publicForm = await service.getPublic("synthetic-form");
		expect(publicForm?.version.id).toBe(v1);
		expect(publicForm?.version.title).toBe("Original");
		expect(publicForm?.version.fields[0]?.label).toBe("Original question");
	});

	it("enforces published, monthly and retention caps from the isolated limits row", async () => {
		const d1 = await mf.getD1Database("DB");
		const limitedOwner = "synthetic-limited-owner";
		await d1
			.prepare(
				"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Limited', 'limited@example.invalid', 1, 1, 1)",
			)
			.bind(limitedOwner)
			.run();
		const limitedService = new FormsService(createDb(d1), () =>
			Date.UTC(2026, 9, 16),
		);
		await d1
			.prepare(
				"UPDATE form_limits SET max_published=1, max_monthly_responses=1, max_retained_responses=1 WHERE id=1",
			)
			.run();
		const one = await limitedService.create(limitedOwner, {
			title: "One",
			accent: "blue",
			fields: sampleFields,
		});
		await limitedService.setSlug(limitedOwner, one!.form!.id, "cap-one");
		const pub = await limitedService.publish(
			limitedOwner,
			one!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		await limitedService.save(
			limitedOwner,
			one!.form!.id,
			{ title: "One updated", accent: "blue", fields: sampleFields },
			1,
		);
		await expect(
			limitedService.publish(
				limitedOwner,
				one!.form!.id,
				"cap-one",
				"https://forms.example.invalid",
				"https://s.example.invalid",
				"public",
			),
		).resolves.toMatchObject({ version: expect.any(String) });
		const two = await limitedService.create(limitedOwner, {
			title: "Two",
			accent: "teal",
			fields: sampleFields,
		});
		await limitedService.setSlug(limitedOwner, two!.form!.id, "cap-two");
		await expect(
			limitedService.publish(
				limitedOwner,
				two!.form!.id,
				undefined,
				"https://forms.example.invalid",
				"https://s.example.invalid",
				"public",
			),
		).rejects.toMatchObject({ code: "PUBLISHED_FORM_LIMIT" });
		await limitedService.acceptResponse(
			one!.form!.id,
			pub!.version,
			"nonce-one",
			{},
		);
		expect(
			(await limitedService.responses(limitedOwner, one!.form!.id))
				?.monthlyLimit,
		).toBe(1);
		await expect(
			limitedService.acceptResponse(
				one!.form!.id,
				pub!.version,
				"nonce-two",
				{},
			),
		).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
		expect(await limitedService.delete(limitedOwner, one!.form!.id)).toBe(true);
		const remaining = await d1
			.prepare("SELECT count(*) as n FROM form_responses WHERE form_id=?")
			.bind(one!.form!.id)
			.first<{ n: number }>();
		expect(remaining?.n).toBe(0);
		expect(await limitedService.getPublic("cap-one")).toBeNull();
		await expect(
			limitedService.publish(
				limitedOwner,
				two!.form!.id,
				undefined,
				"https://forms.example.invalid",
				"https://s.example.invalid",
				"public",
			),
		).resolves.toMatchObject({ version: expect.any(String) });
		const tombstoneOwner = "synthetic-tombstone-owner";
		await d1
			.prepare(
				"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Tombstone', 'tombstone@example.invalid', 1, 1, 1)",
			)
			.bind(tombstoneOwner)
			.run();
		const tombstoneForm = await limitedService.create(tombstoneOwner, {
			title: "Tombstone",
			accent: "pink",
			fields: sampleFields,
		});
		await expect(
			limitedService.setSlug(
				tombstoneOwner,
				tombstoneForm!.form!.id,
				"cap-one",
			),
		).rejects.toMatchObject({ code: "SLUG_TAKEN" });
		const usage = await d1
			.prepare("SELECT response_count FROM form_monthly_usage WHERE owner_id=?")
			.bind(limitedOwner)
			.first<{ response_count: number }>();
		expect(usage?.response_count).toBe(1);
	});

	it("retains the newest response while deletions leave monthly accepted usage intact", async () => {
		const d1 = await mf.getD1Database("DB");
		const retainedOwner = "synthetic-retained-owner";
		await d1
			.prepare(
				"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Retained', 'retained@example.invalid', 1, 1, 1)",
			)
			.bind(retainedOwner)
			.run();
		const monthOne = new FormsService(createDb(d1), () =>
			Date.UTC(2026, 9, 16),
		);
		const form = await monthOne.create(retainedOwner, {
			title: "Retention",
			accent: "green",
			fields: sampleFields,
		});
		await monthOne.setSlug(retainedOwner, form!.form!.id, "retention-form");
		const published = await monthOne.publish(
			retainedOwner,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		await d1
			.prepare(
				"UPDATE form_limits SET max_published=25, max_monthly_responses=10, max_retained_responses=1 WHERE id=1",
			)
			.run();
		await monthOne.acceptResponse(
			form!.form!.id,
			published!.version,
			"old-response",
			{ value: "old" },
		);
		const monthTwo = new FormsService(createDb(d1), () =>
			Date.UTC(2026, 10, 1),
		);
		await monthTwo.acceptResponse(
			form!.form!.id,
			published!.version,
			"new-response",
			{ value: "new" },
		);
		const retainedRows = await d1
			.prepare("SELECT answers_json FROM form_responses WHERE form_id=?")
			.bind(form!.form!.id)
			.all<{ answers_json: string }>();
		const retained = retainedRows.results[0];
		expect(retained?.answers_json).toBe('{"value":"new"}');
		const listed = await monthTwo.list(retainedOwner);
		expect(listed.forms[0]?.responseCount).toBe(1);
		await monthTwo.deleteResponse(retainedOwner, form!.form!.id);
		expect((await monthTwo.list(retainedOwner)).forms[0]?.responseCount).toBe(
			0,
		);
		const accepted = await d1
			.prepare(
				"SELECT response_count FROM form_monthly_usage WHERE owner_id=? AND month='2026-11'",
			)
			.bind(retainedOwner)
			.first<{ response_count: number }>();
		expect(accepted?.response_count).toBe(1);
	});

	it("reserves aliases globally and preserves old addresses after a slug change", async () => {
		const first = await service.create(owner, {
			title: "Slug owner",
			accent: "blue",
			fields: sampleFields,
		});
		await service.setSlug(owner, first!.form!.id, "first-address");
		await service.publish(
			owner,
			first!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		await service.setSlug(owner, first!.form!.id, "new-address");
		const oldAddress = await service.getPublic("first-address");
		expect(oldAddress?.canonicalSlug).toBe("new-address");
		const otherOwner = "synthetic-alias-owner";
		const d1 = await mf.getD1Database("DB");
		await d1
			.prepare(
				"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Alias', 'alias@example.invalid', 1, 1, 1)",
			)
			.bind(otherOwner)
			.run();
		const other = await service.create(otherOwner, {
			title: "Other",
			accent: "teal",
			fields: sampleFields,
		});
		await expect(
			service.setSlug(otherOwner, other!.form!.id, "first-address"),
		).rejects.toMatchObject({ code: "SLUG_TAKEN" });
	});

	it("keeps one mutable draft snapshot and rejects overlapping revision saves", async () => {
		const d1 = await mf.getD1Database("DB");
		const draftOwner = "synthetic-draft-owner";
		await d1
			.prepare(
				"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Draft', 'draft@example.invalid', 1, 1, 1)",
			)
			.bind(draftOwner)
			.run();
		const draftService = new FormsService(createDb(d1));
		const created = await draftService.create(draftOwner, {
			title: "Initial draft",
			accent: "blue",
			fields: sampleFields,
		});
		if (!created?.form) throw new Error("Expected a created form");
		const formId = created.form.id;
		const concurrent = await Promise.allSettled([
			draftService.save(
				draftOwner,
				formId,
				{ title: "Winner A", accent: "blue", fields: sampleFields },
				created.revision,
			),
			draftService.save(
				draftOwner,
				formId,
				{ title: "Winner B", accent: "teal", fields: sampleFields },
				created.revision,
			),
		]);
		const fulfilled = concurrent.filter(
			(result) => result.status === "fulfilled",
		);
		const rejected = concurrent.filter(
			(result) => result.status === "rejected",
		);
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		if (rejected[0]?.status !== "rejected")
			throw new Error("Expected one conflicting revision save");
		expect(rejected[0].reason).toMatchObject({ code: "REVISION_CONFLICT" });
		const winner = await draftService.get(draftOwner, formId);
		if (!winner) throw new Error("Expected a winning draft save");
		if (!winner.draft) throw new Error("Expected the winning mutable draft");
		expect(winner.draft.title).toMatch(/^Winner [AB]$/);
		const rowCounts = async () => {
			const result = await d1
				.prepare(
					"SELECT count(*) AS total, sum(published_at IS NULL) AS drafts FROM form_versions WHERE form_id=?",
				)
				.bind(formId)
				.first<{ total: number; drafts: number }>();
			if (!result) throw new Error("Expected version row counts");
			return result;
		};
		expect(await rowCounts()).toMatchObject({ total: 1, drafts: 1 });
		const updated = await draftService.save(
			draftOwner,
			formId,
			{ title: "Updated draft", accent: "pink", fields: sampleFields },
			winner.revision,
		);
		if (!updated) throw new Error("Expected updated draft");
		expect(updated.revision).toBe(winner.revision + 1);
		expect(await rowCounts()).toMatchObject({ total: 1, drafts: 1 });
		const published = await draftService.publish(
			draftOwner,
			formId,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		if (!published) throw new Error("Expected the draft to publish");
		const updatedAfterPublish = await draftService.save(
			draftOwner,
			formId,
			{ title: "Next draft", accent: "green", fields: sampleFields },
			published.revision,
		);
		if (!updatedAfterPublish) throw new Error("Expected post-publish draft");
		await draftService.save(
			draftOwner,
			formId,
			{ title: "Latest draft", accent: "orange", fields: sampleFields },
			updatedAfterPublish.revision,
		);
		expect(await rowCounts()).toMatchObject({ total: 2, drafts: 1 });
		const publishedSlug = published.form.slug;
		if (!publishedSlug) throw new Error("Expected a published slug");
		const publicForm = await draftService.getPublic(publishedSlug);
		expect(publicForm?.version.title).toBe("Updated draft");
	});

	it("assigns a stable title-based address when first publishing without a slug", async () => {
		const form = await service.create(owner, {
			title: "A Friendly Registration Form",
			accent: "blue",
			fields: sampleFields,
		});
		const first = await service.publish(
			owner,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		expect(first?.form.slug).toMatch(
			/^a-friendly-registration-form-[a-z0-9]{8}$/,
		);
		expect(first?.url).toBe(
			`https://forms.example.invalid/f/${first?.form.slug}`,
		);
		const second = await service.publish(
			owner,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		expect(second?.form.slug).toBe(first?.form.slug);
		expect(second?.shortUrl).toBe(first?.shortUrl);
	});

	it("keeps respondent access attached to the published version until republish", async () => {
		const form = await service.create(owner, {
			title: "Access policy",
			accent: "blue",
			fields: sampleFields,
		});
		const id = form!.form!.id;
		await service.setSlug(owner, id, "access-policy");
		await service.publish(
			owner,
			id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		const originalPublic = await service.getPublic("access-policy");
		await service.save(owner, id, {
			title: "Access policy draft",
			accent: "teal",
			fields: sampleFields,
		});
		expect(
			(await service.getPublic("access-policy"))?.version.respondentAccess,
		).toBe("public");
		await service.publish(
			owner,
			id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"verified_email",
		);
		const verified = await service.getPublic("access-policy");
		expect(verified?.version.respondentAccess).toBe("verified_email");
		expect(verified?.version.id).not.toBe(originalPublic?.version.id);
		await service.publish(
			owner,
			id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		const publicAgain = await service.getPublic("access-policy");
		expect(publicAgain?.version.respondentAccess).toBe("public");
		expect(publicAgain?.version.id).not.toBe(verified?.version.id);
		expect(
			(await service.getVersion(id, verified!.version.id))?.respondentAccess,
		).toBe("verified_email");
	});

	it("counts a concurrent idempotent insert once and closes collection atomically", async () => {
		const first = await service.create(owner, {
			title: "Concurrent",
			accent: "pink",
			fields: sampleFields,
		});
		await service.setSlug(owner, first!.form!.id, "concurrent-form");
		const published = await service.publish(
			owner,
			first!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		const attempts = await Promise.all([
			service.acceptResponse(
				first!.form!.id,
				published!.version,
				"same-render-nonce",
				{ answer: "one" },
			),
			service.acceptResponse(
				first!.form!.id,
				published!.version,
				"same-render-nonce",
				{ answer: "one" },
			),
		]);
		expect(attempts.filter((result) => result.duplicate).length).toBe(1);
		expect(attempts.filter((result) => !result.duplicate).length).toBe(1);
		await service.delete(owner, first!.form!.id);
		await expect(
			service.acceptResponse(
				first!.form!.id,
				published!.version,
				"closed-render-nonce",
				{},
			),
		).rejects.toMatchObject({ code: "FORM_VERSION_CLOSED" });
	});
});
