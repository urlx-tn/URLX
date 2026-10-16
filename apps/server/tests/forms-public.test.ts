import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FormsService } from "@urlx/api/modules/forms/forms.service";
import { createDb } from "@urlx/db";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formsApp, localFormRateLimit } from "../src/forms";

const testDirectory = dirname(fileURLToPath(import.meta.url));
let mf: Miniflare;

beforeAll(async () => {
	mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('ok') } }",
		compatibilityDate: "2026-05-01",
		d1Databases: ["DB"],
	});
	const d1 = await mf.getD1Database("DB");
	for (const name of [
		"0000_faulty_iron_patriot.sql",
		"0001_handy_shocker.sql",
		"0002_forms_auth.sql",
	]) {
		const sql = await readFile(
			resolve(testDirectory, `../../../packages/db/src/migrations/${name}`),
			"utf8",
		);
		for (const statement of sql
			.split("--> statement-breakpoint")
			.map((part) => part.trim())
			.filter(Boolean))
			await d1.prepare(statement).run();
	}
}, 30_000);

afterAll(async () => {
	await mf?.dispose();
});

describe("public forms Hono routes", () => {
	it("renders no-JavaScript submissions, preserves invalid values and enforces the signed render version", async () => {
		const d1 = await mf.getD1Database("DB");
		const owner = "synthetic-public-owner";
		await d1
			.prepare(
				"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Public', 'public@example.invalid', 1, 1, 1)",
			)
			.bind(owner)
			.run();
		const service = new FormsService(createDb(d1), () => Date.UTC(2026, 9, 16));
		const form = await service.create(owner, {
			title: "Native form",
			accent: "orange",
			fields: [{ id: "email", type: "email", label: "Email", required: true }],
		});
		await service.setSlug(owner, form!.form!.id, "native-form");
		await service.publish(
			owner,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
		);
		const env = {
			DB: d1,
			FORMS_ENABLED: true,
			BETTER_AUTH_SECRET: "synthetic-test-secret-not-for-deployment",
			BETTER_AUTH_URL: "https://forms.example.invalid",
			RESEND_API_KEY: "re_test_not_sent",
			AUTH_EMAIL_FROM: "URLX <forms@example.invalid>",
		};
		const get = await formsApp.request(
			"/api/forms/public/native-form",
			{},
			env as never,
		);
		expect(get.headers.get("cache-control")).toBe("no-store");
		const token = (await get.json()) as {
			version: { id: string };
			submissionToken: string;
			idempotencyKey: string;
		};
		const bad = new URLSearchParams({
			versionId: token.version.id,
			submissionToken: token.submissionToken,
			idempotencyKey: token.idempotencyKey,
			"answers[email]": "not-an-email",
		});
		const invalid = await formsApp.request(
			"/api/forms/public/native-form/submit",
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					accept: "text/html",
				},
				body: bad,
			},
			env as never,
		);
		expect(invalid.status).toBe(422);
		const html = await invalid.text();
		expect(html).toContain('value="not-an-email"');
		expect(html).toContain('aria-invalid="true"');
		const forged = new URLSearchParams({
			versionId: "unpublished-version",
			submissionToken: token.submissionToken,
			idempotencyKey: token.idempotencyKey,
			"answers[email]": "person@example.com",
		});
		const rejected = await formsApp.request(
			"/api/forms/public/native-form/submit",
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					accept: "application/json",
				},
				body: forged,
			},
			env as never,
		);
		expect(rejected.status).toBe(403);
		const good = new URLSearchParams({
			versionId: token.version.id,
			submissionToken: token.submissionToken,
			idempotencyKey: token.idempotencyKey,
			"answers[email]": "person@example.com",
		});
		const submitted = await formsApp.request(
			"/api/forms/public/native-form/submit",
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					accept: "text/html",
				},
				body: good,
			},
			env as never,
		);
		expect(submitted.status).toBe(303);
		expect(submitted.headers.get("location")).toContain("?submitted=1");
		const duplicate = await formsApp.request(
			"/api/forms/public/native-form/submit",
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					accept: "application/json",
				},
				body: good,
			},
			env as never,
		);
		expect(((await duplicate.json()) as { duplicate: boolean }).duplicate).toBe(
			true,
		);
		const rows = await d1
			.prepare("SELECT count(*) as n FROM form_responses WHERE form_id=?")
			.bind(form!.form!.id)
			.first<{ n: number }>();
		expect(rows?.n).toBe(1);
		const oversized = await formsApp.request(
			"/api/forms/public/native-form/submit",
			{
				method: "POST",
				headers: {
					"content-type": "multipart/form-data; boundary=synthetic",
					"content-length": "1",
					accept: "text/html",
				},
				body: `payload=${"x".repeat(65_536)}`,
			},
			env as never,
		);
		expect(oversized.status).toBe(413);
		for (let i = 0; i < 30; i += 1)
			expect(localFormRateLimit("synthetic-local-render", 30, 1_800_000)).toBe(
				true,
			);
		expect(localFormRateLimit("synthetic-local-render", 30, 1_800_000)).toBe(
			false,
		);
		const cloudflareLimited = await formsApp.request(
			"/api/forms/public/native-form",
			{},
			{
				...env,
				FORMS_RENDER_RATE_LIMIT: { limit: async () => ({ success: false }) },
			} as never,
		);
		expect(cloudflareLimited.status).toBe(429);
	});

	it("sends a passwordless link through a captured local mail transport and completes the cookie session", async () => {
		const d1 = await mf.getD1Database("DB");
		const env = {
			DB: d1,
			FORMS_ENABLED: true,
			BETTER_AUTH_SECRET: "synthetic-auth-test-secret-not-for-deployment",
			BETTER_AUTH_URL: "https://forms.example.invalid",
			CORS_ORIGIN: "https://forms.example.invalid",
			SHORT_URL_BASE: "https://s.example.invalid",
			RESEND_API_KEY: "re_test_not_sent",
			AUTH_EMAIL_FROM: "URLX <forms@example.invalid>",
		};
		let capturedHtml = "";
		let capturedTo: string[] = [];
		vi.stubGlobal(
			"fetch",
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const payload = JSON.parse(String(init?.body ?? "{}")) as {
					html?: string;
					to?: string[];
				};
				capturedHtml = payload.html ?? "";
				capturedTo = payload.to ?? [];
				return new Response(JSON.stringify({ id: "synthetic-email-id" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		);
		try {
			const sent = await formsApp.request(
				"/api/auth/sign-in/magic-link",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: "magic@example.invalid",
						callbackURL: "/forms",
					}),
				},
				env as never,
			);
			expect(sent.status).toBe(200);
			expect(capturedTo).toContain("magic@example.invalid");
			const match = /href="([^"]+)"/.exec(capturedHtml);
			expect(match).not.toBeNull();
			const signInUrl = new URL((match![1] ?? "").replace(/&amp;/g, "&"));
			const verified = await formsApp.request(
				`${signInUrl.pathname}${signInUrl.search}`,
				{ method: "GET", redirect: "manual" },
				env as never,
			);
			expect(verified.status).toBe(302);
			const cookieHeader = verified.headers.get("set-cookie") ?? "";
			const sessionCookie =
				/(?:__Secure-)?urlx-forms\.session_token=[^;,]+/.exec(
					cookieHeader,
				)?.[0];
			expect(sessionCookie).toBeTruthy();
			const dashboard = await formsApp.request(
				"/api/forms",
				{ headers: { cookie: sessionCookie! } },
				env as never,
			);
			expect(dashboard.status).toBe(200);
			expect(dashboard.headers.get("cache-control")).toBe("no-store");
			const foreignOwner = "synthetic-foreign-owner";
			const d1 = await mf.getD1Database("DB");
			await d1
				.prepare(
					"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Foreign', 'foreign@example.invalid', 1, 1, 1)",
				)
				.bind(foreignOwner)
				.run();
			const foreign = await new FormsService(createDb(d1)).create(
				foreignOwner,
				{ title: "Private form", accent: "teal", fields: [] },
			);
			const foreignId = foreign!.form!.id;
			const privateRequests = [
				formsApp.request(
					`/api/forms/${foreignId}`,
					{ headers: { cookie: sessionCookie! } },
					env as never,
				),
				formsApp.request(
					`/api/forms/${foreignId}/draft`,
					{
						method: "PUT",
						headers: {
							cookie: sessionCookie!,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							revision: 1,
							draft: { title: "Takeover", accent: "blue", fields: [] },
						}),
					},
					env as never,
				),
				formsApp.request(
					`/api/forms/${foreignId}/publish`,
					{
						method: "POST",
						headers: {
							cookie: sessionCookie!,
							"content-type": "application/json",
						},
						body: JSON.stringify({ slug: "foreign-private" }),
					},
					env as never,
				),
				formsApp.request(
					`/api/forms/${foreignId}/responses`,
					{ headers: { cookie: sessionCookie! } },
					env as never,
				),
				formsApp.request(
					`/api/forms/${foreignId}/export.csv`,
					{ headers: { cookie: sessionCookie! } },
					env as never,
				),
				formsApp.request(
					`/api/forms/${foreignId}`,
					{ method: "DELETE", headers: { cookie: sessionCookie! } },
					env as never,
				),
			];
			const denied = await Promise.all(privateRequests);
			expect(denied.map((response) => response.status)).toEqual([
				404, 404, 404, 404, 404, 404,
			]);
			expect(denied[4]?.headers.get("cache-control")).toBe("no-store");
			const created = await formsApp.request(
				"/api/forms",
				{
					method: "POST",
					headers: {
						cookie: sessionCookie!,
						"content-type": "application/json",
					},
					body: JSON.stringify({ template: "blank", title: "CSV test" }),
				},
				env as never,
			);
			expect(created.status).toBe(201);
			const createdBody = (await created.json()) as {
				form: { id: string };
				revision: number;
			};
			const saved = await formsApp.request(
				`/api/forms/${createdBody.form.id}/draft`,
				{
					method: "PUT",
					headers: {
						cookie: sessionCookie!,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						revision: createdBody.revision,
						draft: {
							title: "CSV test",
							accent: "blue",
							confirmationMessage: "Saved",
							fields: [
								{ id: "q", type: "short", label: "Value", required: false },
							],
						},
					}),
				},
				env as never,
			);
			expect(saved.status).toBe(200);
			const published = await formsApp.request(
				`/api/forms/${createdBody.form.id}/publish`,
				{
					method: "POST",
					headers: {
						cookie: sessionCookie!,
						"content-type": "application/json",
					},
					body: JSON.stringify({ slug: "csv-test-form" }),
				},
				env as never,
			);
			expect(published.status).toBe(200);
			const publicData = await formsApp.request(
				"/api/forms/public/csv-test-form",
				{},
				env as never,
			);
			const token = (await publicData.json()) as {
				version: { id: string };
				submissionToken: string;
				idempotencyKey: string;
			};
			const responseBody = new URLSearchParams({
				versionId: token.version.id,
				submissionToken: token.submissionToken,
				idempotencyKey: token.idempotencyKey,
				"answers[q]": "\u0000=1+1",
			});
			const accepted = await formsApp.request(
				"/api/forms/public/csv-test-form/submit",
				{
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						accept: "application/json",
					},
					body: responseBody,
				},
				env as never,
			);
			expect(accepted.status).toBe(200);
			const exported = await formsApp.request(
				`/api/forms/${createdBody.form.id}/export.csv`,
				{ headers: { cookie: sessionCookie! } },
				env as never,
			);
			expect(exported.headers.get("cache-control")).toBe("no-store");
			expect(await exported.text()).toContain("'\u0000=1+1");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
