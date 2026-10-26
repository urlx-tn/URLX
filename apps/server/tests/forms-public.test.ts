import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FormsService } from "@urlx/api/modules/forms/forms.service";
import { createDb } from "@urlx/db";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formsApp, localFormRateLimit } from "../src/forms";
import { formsOgApp } from "../src/forms-og";

vi.mock("../src/forms-og/renderer", () => ({
	renderFormOg: vi.fn(async (_meta: unknown, fields: unknown[]) =>
		new TextEncoder().encode(JSON.stringify(fields)),
	),
}));

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
		"0003_respondent_access.sql",
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
			fields: [
				{ id: "email", type: "email", label: "Email", required: true },
				{ id: "date", type: "date", label: "Date", required: false },
			],
		});
		await service.setSlug(owner, form!.form!.id, "native-form");
		await service.publish(
			owner,
			form!.form!.id,
			undefined,
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
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
		const [encodedToken, encodedSignature] = token.submissionToken.split(".");
		const changedSignature = `${encodedSignature!.slice(0, -1)}${encodedSignature!.endsWith("A") ? "B" : "A"}`;
		const tampered = await formsApp.request(
			"/api/forms/public/native-form/submit",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify({
					versionId: token.version.id,
					submissionToken: `${encodedToken}.${changedSignature}`,
					idempotencyKey: token.idempotencyKey,
					answers: { email: "person@example.com" },
				}),
			},
			env as never,
		);
		expect(tampered.status).toBe(403);
		const currentTime = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(currentTime + 60 * 60_000 + 1);
		try {
			const expired = await formsApp.request(
				"/api/forms/public/native-form/submit",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({
						versionId: token.version.id,
						submissionToken: token.submissionToken,
						idempotencyKey: token.idempotencyKey,
						answers: { email: "person@example.com" },
					}),
				},
				env as never,
			);
			expect(expired.status).toBe(403);
			expect(await expired.json()).toMatchObject({
				error: "INVALID_SUBMISSION_TOKEN",
			});
		} finally {
			vi.useRealTimers();
		}
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
		for (const date of [
			"0000-01-01",
			"1900-02-29",
			"2026-02-29",
			"2026-1-01",
			"not-a-date",
		]) {
			const invalidDate = await formsApp.request(
				"/api/forms/public/native-form/submit",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({
						versionId: token.version.id,
						submissionToken: token.submissionToken,
						idempotencyKey: token.idempotencyKey,
						answers: { email: "person@example.com", date },
					}),
				},
				env as never,
			);
			expect(invalidDate.status).toBe(422);
			expect(await invalidDate.json()).toMatchObject({ error: "INVALID_DATE" });
		}
		const good = new URLSearchParams({
			versionId: token.version.id,
			submissionToken: token.submissionToken,
			idempotencyKey: token.idempotencyKey,
			"answers[email]": "person@example.com",
			"answers[date]": "2000-02-29",
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

	it("enforces the immutable access policy attached to each submission token version", async () => {
		const d1 = await mf.getD1Database("DB");
		const owner = "synthetic-version-policy-owner";
		const now = Date.now();
		await d1
			.prepare(
				"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Owner', 'version-policy-owner@example.invalid', 1, ?, ?)",
			)
			.bind(owner, now, now)
			.run();
		const env = {
			DB: d1,
			FORMS_ENABLED: true,
			BETTER_AUTH_SECRET: "synthetic-version-policy-secret-not-for-deployment",
			BETTER_AUTH_URL: "https://forms.example.invalid",
			RESEND_API_KEY: "re_test_not_sent",
			AUTH_EMAIL_FROM: "URLX <forms@example.invalid>",
			FORMS_RENDER_RATE_LIMIT: { limit: async () => ({ success: true }) },
			FORMS_SUBMIT_RATE_LIMIT: { limit: async () => ({ success: true }) },
		};
		let capturedHtml = "";
		vi.stubGlobal(
			"fetch",
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const payload = JSON.parse(String(init?.body ?? "{}")) as {
					html?: string;
				};
				capturedHtml = payload.html ?? "";
				return new Response(JSON.stringify({ id: "synthetic-version-email" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		);
		let verifiedCookie = "";
		try {
			const sent = await formsApp.request(
				"/api/auth/sign-in/magic-link",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: "version-policy-respondent@example.invalid",
						callbackURL: "/forms",
					}),
				},
				env as never,
			);
			expect(sent.status).toBe(200);
			const signInLink = /href="([^"]+)"/.exec(capturedHtml)?.[1];
			expect(signInLink).toBeTruthy();
			const signInUrl = new URL(signInLink!.replace(/&amp;/g, "&"));
			const verified = await formsApp.request(
				`${signInUrl.pathname}${signInUrl.search}`,
				{ method: "GET", redirect: "manual" },
				env as never,
			);
			const cookieHeader = verified.headers.get("set-cookie") ?? "";
			verifiedCookie =
				/(?:__Secure-)?urlx-forms\.session_token=[^;,]+/.exec(
					cookieHeader,
				)?.[0] ?? "";
			expect(verifiedCookie).toBeTruthy();
		} finally {
			vi.unstubAllGlobals();
		}
		const service = new FormsService(createDb(d1));
		const form = await service.create(owner, {
			title: "Version access",
			accent: "blue",
			fields: [
				{
					id: "old-answer",
					type: "short",
					label: "Old answer",
					required: true,
				},
			],
		});
		const formId = form!.form!.id;
		await service.setSlug(owner, formId, "version-access-policy");

		const readToken = async (cookie?: string) => {
			const response = await formsApp.request(
				"/api/forms/public/version-access-policy",
				{
					headers: {
						"cf-connecting-ip": crypto.randomUUID(),
						...(cookie ? { cookie } : {}),
					},
				},
				env as never,
			);
			return {
				status: response.status,
				data: (await response.json()) as {
					requiresSignIn?: boolean;
					version?: { id: string };
					fields?: Array<{ id: string }>;
					submissionToken?: string;
					idempotencyKey?: string;
				},
			};
		};
		const publish = (access: "public" | "verified_email") =>
			service.publish(
				owner,
				formId,
				undefined,
				"https://forms.example.invalid",
				"https://s.example.invalid",
				access,
			);
		const saveDraft = async (label: string) => {
			const current = await service.get(owner, formId);
			await service.save(
				owner,
				formId,
				{
					title: `Version access ${label}`,
					accent: "teal",
					fields: [{ id: label, type: "short", label, required: true }],
				},
				current!.revision,
			);
		};
		const submit = async (
			token: NonNullable<Awaited<ReturnType<typeof readToken>>["data"]>,
			fieldId: string,
			answer: string,
			cookie?: string,
		) =>
			formsApp.request(
				"/api/forms/public/version-access-policy/submit",
				{
					method: "POST",
					headers: {
						"cf-connecting-ip": crypto.randomUUID(),
						"content-type": "application/json",
						accept: "application/json",
						...(cookie ? { cookie } : {}),
					},
					body: JSON.stringify({
						versionId: token.version!.id,
						submissionToken: token.submissionToken,
						idempotencyKey: token.idempotencyKey,
						answers: { [fieldId]: answer },
					}),
				},
				env as never,
			);

		await publish("verified_email");
		const firstToken = await readToken(verifiedCookie);
		expect(firstToken.status).toBe(200);
		expect(firstToken.data.submissionToken).toBeTruthy();
		await saveDraft("new-private-version");
		await publish("public");
		const staleVerifiedToken = await submit(
			firstToken.data,
			"old-answer",
			"old answer",
		);
		expect(staleVerifiedToken.status).toBe(401);
		expect(await staleVerifiedToken.json()).toMatchObject({
			error: "SIGN_IN_REQUIRED",
		});

		await saveDraft("public-version");
		await publish("public");
		const publicToken = await readToken();
		expect(publicToken.status).toBe(200);
		await saveDraft("new-verified-version");
		await publish("verified_email");
		try {
			const stalePublicToken = await submit(
				publicToken.data,
				"public-version",
				"old public answer",
			);
			expect(stalePublicToken.status).toBe(200);
			expect(await stalePublicToken.json()).toMatchObject({ success: true });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("deduplicates repeated allowed choices before storing a response", async () => {
		const d1 = await mf.getD1Database("DB");
		const owner = "synthetic-multichoice-owner";
		await d1
			.prepare(
				"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Owner', 'multichoice-owner@example.invalid', 1, 1, 1)",
			)
			.bind(owner)
			.run();
		const service = new FormsService(createDb(d1));
		const form = await service.create(owner, {
			title: "Unique choices",
			accent: "blue",
			fields: [
				{
					id: "colors",
					type: "multichoice",
					label: "Colors",
					options: ["red", "blue"],
					required: true,
				},
			],
		});
		await service.publish(
			owner,
			form!.form!.id,
			"unique-choices",
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"public",
		);
		const env = {
			DB: d1,
			FORMS_ENABLED: true,
			BETTER_AUTH_SECRET: "synthetic-multichoice-secret-not-for-deployment",
			BETTER_AUTH_URL: "https://forms.example.invalid",
			RESEND_API_KEY: "re_test_not_sent",
			AUTH_EMAIL_FROM: "URLX <forms@example.invalid>",
			FORMS_RENDER_RATE_LIMIT: { limit: async () => ({ success: true }) },
			FORMS_SUBMIT_RATE_LIMIT: { limit: async () => ({ success: true }) },
		};
		const publicForm = await formsApp.request(
			"/api/forms/public/unique-choices",
			{ headers: { "cf-connecting-ip": "198.51.100.210" } },
			env as never,
		);
		const token = (await publicForm.json()) as {
			version: { id: string };
			submissionToken: string;
			idempotencyKey: string;
		};
		const submitted = await formsApp.request(
			"/api/forms/public/unique-choices/submit",
			{
				method: "POST",
				headers: {
					"cf-connecting-ip": "198.51.100.210",
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify({
					versionId: token.version.id,
					submissionToken: token.submissionToken,
					idempotencyKey: token.idempotencyKey,
					answers: { colors: ["red", "red", "blue", "red"] },
				}),
			},
			env as never,
		);
		expect(submitted.status).toBe(200);
		const stored = await d1
			.prepare("SELECT answers_json FROM form_responses WHERE form_id=?")
			.bind(form!.form!.id)
			.first<{ answers_json: string }>();
		expect(JSON.parse(stored!.answers_json)).toEqual({
			colors: ["red", "blue"],
		});
	});

	it("requires a verified Better Auth session for gated rendering and submission", async () => {
		const d1 = await mf.getD1Database("DB");
		const owner = "synthetic-respondent-gate-owner";
		await d1
			.prepare(
				"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Owner', 'gate-owner@example.invalid', 1, 1, 1)",
			)
			.bind(owner)
			.run();
		const service = new FormsService(createDb(d1));
		const form = await service.create(owner, {
			title: "Email protected",
			accent: "teal",
			fields: [
				{ id: "answer", type: "short", label: "Answer", required: false },
			],
		});
		await service.publish(
			owner,
			form!.form!.id,
			"email-protected",
			"https://forms.example.invalid",
			"https://s.example.invalid",
			"verified_email",
		);
		const env = {
			DB: d1,
			FORMS_ENABLED: true,
			BETTER_AUTH_SECRET: "synthetic-respondent-gate-secret-not-for-deployment",
			BETTER_AUTH_URL: "https://forms.example.invalid",
			RESEND_API_KEY: "re_test_not_sent",
			AUTH_EMAIL_FROM: "URLX <forms@example.invalid>",
		};
		const og = await formsOgApp.request(
			"/api/forms/public/email-protected/og.png",
			{},
			env as never,
		);
		expect(og.status).toBe(200);
		expect(og.headers.get("cache-control")).toBe("no-store");
		expect(await og.text()).toBe("[]");
		const anonymousForm = await formsApp.request(
			"/api/forms/public/email-protected",
			{},
			env as never,
		);
		const anonymousData = (await anonymousForm.json()) as Record<string, any>;
		expect(anonymousData.requiresSignIn).toBe(true);
		expect(anonymousData.version.fields).toEqual([]);
		expect(anonymousData.form.confirmationMessage).toBeUndefined();
		expect(anonymousData.submissionToken).toBeUndefined();
		const bypass = await formsApp.request(
			"/api/forms/public/email-protected/submit",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answers: {} }),
			},
			env as never,
		);
		expect(bypass.status).toBe(401);
		expect(await bypass.json()).toMatchObject({ error: "SIGN_IN_REQUIRED" });
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
			FORMS_RENDER_RATE_LIMIT: { limit: async () => ({ success: true }) },
			FORMS_SUBMIT_RATE_LIMIT: { limit: async () => ({ success: true }) },
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
			for (const title of [
				"Pagination fixture A",
				"Pagination fixture B",
				"Pagination fixture C",
			]) {
				const createdForPagination = await formsApp.request(
					"/api/forms",
					{
						method: "POST",
						headers: {
							cookie: sessionCookie!,
							"content-type": "application/json",
						},
						body: JSON.stringify({ template: "blank", title }),
					},
					env as never,
				);
				expect(createdForPagination.status).toBe(201);
			}
			const firstPageResponse = await formsApp.request(
				"/api/forms?limit=1&search=Pagination%20fixture",
				{ headers: { cookie: sessionCookie! } },
				env as never,
			);
			expect(firstPageResponse.status).toBe(200);
			const firstPage = (await firstPageResponse.json()) as {
				forms: Array<{ id: string }>;
				totalForms: number;
				nextCursor: string | null;
				usage: { forms: number };
			};
			expect(firstPage.forms).toHaveLength(1);
			expect(firstPage.totalForms).toBe(3);
			expect(firstPage.usage.forms).toBe(3);
			expect(firstPage.nextCursor).toBeTruthy();
			const secondPageResponse = await formsApp.request(
				`/api/forms?limit=1&search=Pagination%20fixture&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
				{ headers: { cookie: sessionCookie! } },
				env as never,
			);
			expect(secondPageResponse.status).toBe(200);
			const secondPage = (await secondPageResponse.json()) as {
				forms: Array<{ id: string }>;
				totalForms: number;
				nextCursor: string | null;
			};
			expect(secondPage.forms).toHaveLength(1);
			expect(secondPage.forms[0]?.id).not.toBe(firstPage.forms[0]?.id);
			expect(secondPage.nextCursor).toBeTruthy();
			const thirdPageResponse = await formsApp.request(
				`/api/forms?limit=1&search=Pagination%20fixture&cursor=${encodeURIComponent(secondPage.nextCursor!)}`,
				{ headers: { cookie: sessionCookie! } },
				env as never,
			);
			expect(thirdPageResponse.status).toBe(200);
			const thirdPage = (await thirdPageResponse.json()) as {
				forms: Array<{ id: string }>;
				totalForms: number;
				nextCursor: string | null;
			};
			expect(thirdPage.forms).toHaveLength(1);
			expect(thirdPage.nextCursor).toBeNull();
			expect(
				new Set([
					firstPage.forms[0]?.id,
					secondPage.forms[0]?.id,
					thirdPage.forms[0]?.id,
				]).size,
			).toBe(3);
			expect(thirdPage.totalForms).toBe(3);
			for (const query of ["limit=0", "limit=101", "limit=1.5"]) {
				const invalid = await formsApp.request(
					`/api/forms?${query}`,
					{ headers: { cookie: sessionCookie! } },
					env as never,
				);
				expect(invalid.status).toBe(400);
				expect(await invalid.json()).toMatchObject({ error: "INVALID_LIMIT" });
			}
			const invalidCursor = await formsApp.request(
				"/api/forms?cursor=not-a-valid-cursor",
				{ headers: { cookie: sessionCookie! } },
				env as never,
			);
			expect(invalidCursor.status).toBe(400);
			expect(await invalidCursor.json()).toMatchObject({
				error: "INVALID_CURSOR",
			});
			const respondentOwner = "synthetic-respondent-authorized-owner";
			await d1
				.prepare(
					"INSERT INTO `user` (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'Owner', 'authorized-owner@example.invalid', 1, 1, 1)",
				)
				.bind(respondentOwner)
				.run();
			const respondentForm = await new FormsService(createDb(d1)).create(
				respondentOwner,
				{
					title: "Verified response",
					accent: "pink",
					fields: [
						{ id: "answer", type: "short", label: "Answer", required: true },
					],
				},
			);
			await new FormsService(createDb(d1)).publish(
				respondentOwner,
				respondentForm!.form!.id,
				"verified-response",
				"https://forms.example.invalid",
				"https://s.example.invalid",
				"verified_email",
			);
			const anonRead = await formsApp.request(
				"/api/forms/public/verified-response",
				{ headers: { "cf-connecting-ip": "198.51.100.77" } },
				env as never,
			);
			const anonymousData = (await anonRead.json()) as {
				requiresSignIn?: boolean;
			};
			expect(anonymousData.requiresSignIn).toBe(true);
			const authorizedRead = await formsApp.request(
				"/api/forms/public/verified-response",
				{
					headers: {
						cookie: sessionCookie!,
						"cf-connecting-ip": "198.51.100.77",
					},
				},
				env as never,
			);
			const authorizedData = (await authorizedRead.json()) as {
				version: { id: string };
				submissionToken: string;
				idempotencyKey: string;
			};
			expect(authorizedRead.status).toBe(200);
			expect(authorizedData.submissionToken).toBeTruthy();
			const respondentAccepted = await formsApp.request(
				"/api/forms/public/verified-response/submit",
				{
					method: "POST",
					headers: {
						cookie: sessionCookie!,
						"cf-connecting-ip": "198.51.100.77",
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({
						versionId: authorizedData.version.id,
						submissionToken: authorizedData.submissionToken,
						idempotencyKey: authorizedData.idempotencyKey,
						answers: { answer: "hello" },
					}),
				},
				env as never,
			);
			expect(respondentAccepted.status).toBe(200);
			const foreignOwner = "synthetic-foreign-owner";
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
						body: JSON.stringify({
							slug: "foreign-private",
							respondentAccess: "public",
						}),
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
				form: { id: string; ownerId: string };
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
								{
									id: "q",
									type: "short",
									label: 'Value, "quoted"',
									required: false,
								},
								{
									id: "colors",
									type: "multichoice",
									label: "Colors",
									options: ["red", "blue"],
									required: false,
								},
								{
									id: "empty",
									type: "short",
									label: "Empty answer",
									required: false,
								},
							],
						},
					}),
				},
				env as never,
			);
			expect(saved.status).toBe(200);
			const missingAccessChoice = await formsApp.request(
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
			expect(missingAccessChoice.status).toBe(400);
			expect(await missingAccessChoice.json()).toMatchObject({
				error: "RESPONDENT_ACCESS_REQUIRED",
			});
			const published = await formsApp.request(
				`/api/forms/${createdBody.form.id}/publish`,
				{
					method: "POST",
					headers: {
						cookie: sessionCookie!,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						slug: "csv-test-form",
						respondentAccess: "public",
					}),
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
			responseBody.append("answers[colors][]", "red");
			responseBody.append("answers[colors][]", "blue");
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
			const initialCsv = await exported.text();
			expect(initialCsv).toContain("'\u0000=1+1");
			expect(initialCsv).toContain('"Value, ""quoted"""');
			expect(initialCsv).toContain('"colors","Colors","red; blue"');
			expect(initialCsv).toContain('"empty","Empty answer",""');
			expect(initialCsv.split("\r\n")[0]).toBe(
				'"response_id","version","version_id","submitted_at","field_id","field_label","answer"',
			);

			const service = new FormsService(createDb(d1));
			for (let version = 3; version <= 20; version += 1) {
				const current = await service.get(
					createdBody.form.ownerId,
					createdBody.form.id,
				);
				const fields = Array.from({ length: 3 }, (_, index) => ({
					id: `q${index}`,
					type: "short" as const,
					label: `Version ${version} question ${index}`,
					required: false,
				}));
				await service.save(
					createdBody.form.ownerId,
					createdBody.form.id,
					{
						title: `CSV version ${version}`,
						accent: "blue",
						fields,
					},
					current!.revision,
				);
				await service.publish(
					createdBody.form.ownerId,
					createdBody.form.id,
					undefined,
					"https://forms.example.invalid",
					"https://s.example.invalid",
					"public",
				);
				const versionTokenResponse = await formsApp.request(
					"/api/forms/public/csv-test-form",
					{ headers: { "cf-connecting-ip": `198.51.100.${version}` } },
					env as never,
				);
				const versionToken = (await versionTokenResponse.json()) as {
					version: { id: string; fields: Array<{ id: string }> };
					submissionToken: string;
					idempotencyKey: string;
				};
				const versionAnswers = Object.fromEntries(
					versionToken.version.fields.map((field) => [
						field.id,
						`answer-${version}-${field.id}`,
					]),
				);
				const acceptedVersion = await formsApp.request(
					"/api/forms/public/csv-test-form/submit",
					{
						method: "POST",
						headers: {
							"cf-connecting-ip": `198.51.100.${version}`,
							"content-type": "application/json",
							accept: "application/json",
						},
						body: JSON.stringify({
							versionId: versionToken.version.id,
							submissionToken: versionToken.submissionToken,
							idempotencyKey: versionToken.idempotencyKey,
							answers: versionAnswers,
						}),
					},
					env as never,
				);
				expect(acceptedVersion.status).toBe(200);
			}
			const manyVersionExport = await formsApp.request(
				`/api/forms/${createdBody.form.id}/export.csv`,
				{ headers: { cookie: sessionCookie! } },
				env as never,
			);
			const manyVersionCsv = await manyVersionExport.text();
			const csvRows = manyVersionCsv.split("\r\n");
			expect(csvRows).toHaveLength(1 + 3 + 18 * 3);
			expect(csvRows[0]).toBe(
				'"response_id","version","version_id","submitted_at","field_id","field_label","answer"',
			);
			expect(manyVersionCsv).toContain("Version 3 question 0");
			expect(manyVersionCsv).toContain("Version 20 question 2");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
