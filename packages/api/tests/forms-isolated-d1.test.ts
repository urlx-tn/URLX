import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@urlx/db";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FormsService } from "../src/modules/forms/forms.service";

const owner = "synthetic-owner";
const testDirectory = dirname(fileURLToPath(import.meta.url));
let mf: Miniflare;
let service: FormsService;

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
			fields: [],
		});
		await limitedService.setSlug(limitedOwner, one!.form!.id, "cap-one");
		const pub = await limitedService.publish(
			limitedOwner,
			one!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
		);
		await limitedService.save(
			limitedOwner,
			one!.form!.id,
			{ title: "One updated", accent: "blue", fields: [] },
			1,
		);
		await expect(
			limitedService.publish(
				limitedOwner,
				one!.form!.id,
				"cap-one",
				"https://forms.example.invalid",
				"https://s.example.invalid",
			),
		).resolves.toMatchObject({ version: expect.any(String) });
		const two = await limitedService.create(limitedOwner, {
			title: "Two",
			accent: "teal",
			fields: [],
		});
		await limitedService.setSlug(limitedOwner, two!.form!.id, "cap-two");
		await expect(
			limitedService.publish(
				limitedOwner,
				two!.form!.id,
				undefined,
				"https://forms.example.invalid",
				"https://s.example.invalid",
			),
		).rejects.toMatchObject({ code: "PUBLISHED_FORM_LIMIT" });
		await limitedService.acceptResponse(
			one!.form!.id,
			pub!.version,
			"nonce-one",
			{},
		);
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
			fields: [],
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
			fields: [],
		});
		await monthOne.setSlug(retainedOwner, form!.form!.id, "retention-form");
		const published = await monthOne.publish(
			retainedOwner,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
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
		await monthTwo.deleteResponse(retainedOwner, form!.form!.id);
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
			fields: [],
		});
		await service.setSlug(owner, first!.form!.id, "first-address");
		await service.publish(
			owner,
			first!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
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
			fields: [],
		});
		await expect(
			service.setSlug(otherOwner, other!.form!.id, "first-address"),
		).rejects.toMatchObject({ code: "SLUG_TAKEN" });
	});

	it("assigns a stable title-based address when first publishing without a slug", async () => {
		const form = await service.create(owner, {
			title: "A Friendly Registration Form",
			accent: "blue",
			fields: [],
		});
		const first = await service.publish(
			owner,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
		);
		expect(first?.form.slug).toMatch(/^a-friendly-registration-form-[a-z0-9]{8}$/);
		expect(first?.url).toBe(
			`https://forms.example.invalid/f/${first?.form.slug}`,
		);
		const second = await service.publish(
			owner,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
		);
		expect(second?.form.slug).toBe(first?.form.slug);
		expect(second?.shortUrl).toBe(first?.shortUrl);
	});

	it("counts a concurrent idempotent insert once and closes collection atomically", async () => {
		const first = await service.create(owner, {
			title: "Concurrent",
			accent: "pink",
			fields: [],
		});
		await service.setSlug(owner, first!.form!.id, "concurrent-form");
		const published = await service.publish(
			owner,
			first!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
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
