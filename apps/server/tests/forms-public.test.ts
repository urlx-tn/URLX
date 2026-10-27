import { fileURLToPath, URL } from "node:url";
import { FormsService } from "@urlx/api/modules/forms/forms.service";
import {
	assertDatabaseIdentity,
	createPgDb,
	createPgPool,
	type DatabaseRoleIdentity,
	type UrlxDb,
	type UrlxDbPool,
} from "@urlx/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formsApp } from "../src/forms";
import { formsOgApp } from "../src/forms-og";
import type { ApiAppBindings } from "../src/runtime/bindings";
import { assertApiDatabaseRole } from "../src/runtime/database-role";

vi.mock("../src/forms-og/renderer", () => ({
	renderFormOg: vi.fn(async (_meta: unknown, fields: unknown[]) =>
		new TextEncoder().encode(JSON.stringify(fields)),
	),
}));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const migratorDatabaseUrl = process.env.TEST_MIGRATOR_DATABASE_URL;
const testRunId = crypto.randomUUID().replaceAll("-", "");
const syntheticId = (name: string) => `${name}-${testRunId}`;
const syntheticEmail = (name: string) => `${name}-${testRunId}@example.invalid`;
const syntheticSlug = (name: string) => `${name}-${testRunId.slice(0, 16)}`;
const versionAccessSlug = syntheticSlug("version-access-policy");
const uniqueChoicesSlug = syntheticSlug("unique-choices");
const emailProtectedSlug = syntheticSlug("email-protected");
const verifiedResponseSlug = syntheticSlug("verified-response");
const csvSlug = syntheticSlug("csv-test-form");
const versionPolicyRespondentEmail = syntheticEmail(
	"version-policy-respondent",
);
const magicTestEmail = syntheticEmail("magic");
const authNullInputEmail = syntheticEmail("auth-null-input");
const owners = new Set<string>();
const extraTestEmails = new Set([
	versionPolicyRespondentEmail,
	magicTestEmail,
	authNullInputEmail,
]);
let pool: UrlxDbPool | undefined;
let db: UrlxDb;
const allowRate = { limit: async () => ({ success: true }) };
const authStorageValues = new Map<
	string,
	{ value: string; expiresAt?: number }
>();
async function getAuthStorageValue(key: string) {
	const entry = authStorageValues.get(key);
	if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
		authStorageValues.delete(key);
		return null;
	}
	return entry?.value ?? null;
}
const testAuthStorage: ApiAppBindings["AUTH_SECONDARY_STORAGE"] = {
	get: getAuthStorageValue,
	async getAndDelete(key) {
		const value = await getAuthStorageValue(key);
		authStorageValues.delete(key);
		return value;
	},
	async increment(key, ttlSeconds) {
		const prior = await getAuthStorageValue(key);
		const value = Number(prior ?? "0") + 1;
		authStorageValues.set(key, {
			value: String(value),
			expiresAt:
				prior === null
					? Date.now() + ttlSeconds * 1000
					: authStorageValues.get(key)?.expiresAt,
		});
		return value;
	},
	async set(key, value, ttlSeconds) {
		authStorageValues.set(key, {
			value,
			...(ttlSeconds === undefined
				? {}
				: { expiresAt: Date.now() + ttlSeconds * 1000 }),
		});
	},
	async delete(key) {
		authStorageValues.delete(key);
	},
};

beforeAll(async () => {
	if (!testDatabaseUrl || !migratorDatabaseUrl)
		throw new Error(
			"Set TEST_DATABASE_URL (urlx_app) and TEST_MIGRATOR_DATABASE_URL (urlx_migrator) to run the PostgreSQL forms route tests.",
		);
	assertTestDatabase(testDatabaseUrl);
	assertTestDatabase(migratorDatabaseUrl);
	const migratorPool = createPgPool(migratorDatabaseUrl, { max: 1 });
	try {
		await assertTestDatabaseRole(migratorPool, "urlx_migrator");
		await expect(assertApiDatabaseRole(migratorPool)).rejects.toThrow(
			"API startup requires the restricted urlx_app database role",
		);
		await migrate(createPgDb(migratorPool) as never, {
			migrationsFolder: fileURLToPath(
				new URL("../../../packages/db/src/migrations/pg/", import.meta.url),
			),
		});
	} finally {
		await migratorPool.end();
	}
	pool = createPgPool(testDatabaseUrl, { max: 4 });
	try {
		await assertApiDatabaseRole(pool);
	} catch (error) {
		await pool.end();
		pool = undefined;
		throw error;
	}
	db = createPgDb(pool);
}, 30_000);

afterAll(async () => {
	if (!pool) return;
	const cleanupPool = createPgPool(migratorDatabaseUrl!, { max: 1 });
	try {
		await assertTestDatabaseRole(cleanupPool, "urlx_migrator");
		for (const email of extraTestEmails) {
			const matching = await db.$client.query<{ id: string }>(
				'SELECT id FROM "user" WHERE email = $1',
				[email],
			);
			for (const user of matching.rows) owners.add(user.id);
		}
		for (const ownerId of owners) {
			const ownedForms = await db.$client.query<{ short_code: string | null }>(
				"SELECT short_code FROM forms WHERE owner_id = $1",
				[ownerId],
			);
			const codes = ownedForms.rows.flatMap((form) =>
				form.short_code ? [form.short_code] : [],
			);
			if (codes.length)
				await cleanupPool.query(
					"DELETE FROM links WHERE short_code = ANY($1)",
					[codes],
				);
			await db.$client.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
		}
	} finally {
		await cleanupPool.end();
		await pool.end();
		pool = undefined;
	}
}, 30_000);

async function createTestOwner(id: string, email: string, name = "Owner") {
	owners.add(id);
	await db.$client.query(
		'INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $2, $3, true, NOW(), NOW()) ON CONFLICT (id) DO NOTHING',
		[id, name, email],
	);
}

function requestForms(
	input: string | URL,
	init?: RequestInit,
	env: Record<string, unknown> = {},
) {
	return formsApp.request(input, init, {
		FORMS_RENDER_RATE_LIMIT: allowRate,
		FORMS_SUBMIT_RATE_LIMIT: allowRate,
		AUTH_SECONDARY_STORAGE: testAuthStorage,
		...env,
	} as never);
}

function assertTestDatabase(value: string) {
	const databaseName = new URL(value).pathname.slice(1).toLowerCase();
	if (!databaseName.includes("test"))
		throw new Error(
			"PostgreSQL integration tests require an explicit database name containing 'test'.",
		);
}

async function assertTestDatabaseRole(
	connection: UrlxDbPool,
	expectedRole: "urlx_app" | "urlx_migrator",
) {
	const result = await connection.query<DatabaseRoleIdentity>(`
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
	const identity = result.rows[0];
	if (!identity) throw new Error("Cannot validate the test database role");
	assertDatabaseIdentity(identity, expectedRole);
}

describe("public forms Hono routes", () => {
	it("renders no-JavaScript submissions, preserves invalid values and enforces the signed render version", async () => {
		const d1 = db;
		const owner = syntheticId("synthetic-public-owner");
		await createTestOwner(owner, syntheticEmail("public"), "Public");
		const service = new FormsService(db, () => Date.UTC(2026, 9, 16));
		const form = await service.create(owner, {
			title: "Native form",
			accent: "orange",
			fields: [
				{ id: "email", type: "email", label: "Email", required: true },
				{ id: "date", type: "date", label: "Date", required: false },
			],
		});
		const publicSlug = syntheticSlug("native-form");
		await service.setSlug(owner, form!.form!.id, publicSlug);
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
		const get = await requestForms(
			`/api/forms/public/${publicSlug}`,
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
		const tampered = await requestForms(
			`/api/forms/public/${publicSlug}/submit`,
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
			const expired = await requestForms(
				`/api/forms/public/${publicSlug}/submit`,
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
		const invalid = await requestForms(
			`/api/forms/public/${publicSlug}/submit`,
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
		const rejected = await requestForms(
			`/api/forms/public/${publicSlug}/submit`,
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
			const invalidDate = await requestForms(
				`/api/forms/public/${publicSlug}/submit`,
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
		const submitted = await requestForms(
			`/api/forms/public/${publicSlug}/submit`,
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
		const duplicate = await requestForms(
			`/api/forms/public/${publicSlug}/submit`,
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
		const rows = await db.$client.query<{ n: string }>(
			"SELECT count(*)::text AS n FROM form_responses WHERE form_id = $1",
			[form!.form!.id],
		);
		expect(Number(rows.rows[0]?.n)).toBe(1);
		const oversized = await requestForms(
			`/api/forms/public/${publicSlug}/submit`,
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
		const sharedLimiterLimited = await requestForms(
			`/api/forms/public/${publicSlug}`,
			{},
			{
				...env,
				FORMS_RENDER_RATE_LIMIT: { limit: async () => ({ success: false }) },
			} as never,
		);
		expect(sharedLimiterLimited.status).toBe(429);
		const limiterUnavailable = await requestForms(
			`/api/forms/public/${publicSlug}`,
			{},
			{
				...env,
				FORMS_RENDER_RATE_LIMIT: {
					limit: async () => {
						throw new Error("private Valkey connection detail");
					},
				},
			} as never,
		);
		expect(limiterUnavailable.status).toBe(503);
		const unavailableBody = await limiterUnavailable.text();
		expect(unavailableBody).toContain('"error":"RATE_LIMIT_UNAVAILABLE"');
		expect(unavailableBody).not.toContain("private Valkey connection detail");
		/* response is generic and never leaks the infrastructure error */
		expect(JSON.parse(unavailableBody)).toMatchObject({
			error: "RATE_LIMIT_UNAVAILABLE",
		});
	});

	it("enforces the immutable access policy attached to each submission token version", async () => {
		const d1 = db;
		const owner = syntheticId("synthetic-version-policy-owner");
		await createTestOwner(owner, syntheticEmail("version-policy-owner"));
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
			const sent = await requestForms(
				"/api/auth/sign-in/magic-link",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: versionPolicyRespondentEmail,
						callbackURL: "/forms",
					}),
				},
				env as never,
			);
			expect(sent.status).toBe(200);
			const signInLink = /href="([^"]+)"/.exec(capturedHtml)?.[1];
			expect(signInLink).toBeTruthy();
			const signInUrl = new URL(signInLink!.replace(/&amp;/g, "&"));
			const verified = await requestForms(
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
		const service = new FormsService(db);
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
		await service.setSlug(owner, formId, versionAccessSlug);

		const readToken = async (cookie?: string) => {
			const response = await requestForms(
				`/api/forms/public/${versionAccessSlug}`,
				{
					headers: {
						"x-urlx-client-ip": crypto.randomUUID(),
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
			requestForms(
				`/api/forms/public/${versionAccessSlug}/submit`,
				{
					method: "POST",
					headers: {
						"x-urlx-client-ip": crypto.randomUUID(),
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
		const d1 = db;
		const owner = syntheticId("synthetic-multichoice-owner");
		await createTestOwner(owner, syntheticEmail("multichoice-owner"));
		const service = new FormsService(db);
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
			uniqueChoicesSlug,
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
		const publicForm = await requestForms(
			`/api/forms/public/${uniqueChoicesSlug}`,
			{ headers: { "x-urlx-client-ip": "198.51.100.210" } },
			env as never,
		);
		const token = (await publicForm.json()) as {
			version: { id: string };
			submissionToken: string;
			idempotencyKey: string;
		};
		const submitted = await requestForms(
			`/api/forms/public/${uniqueChoicesSlug}/submit`,
			{
				method: "POST",
				headers: {
					"x-urlx-client-ip": "198.51.100.210",
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
		const stored = await db.$client.query<{ answers_json: string }>(
			"SELECT answers_json FROM form_responses WHERE form_id = $1 LIMIT 1",
			[form!.form!.id],
		);
		expect(JSON.parse(stored.rows[0]!.answers_json)).toEqual({
			colors: ["red", "blue"],
		});
	});

	it("requires a verified Better Auth session for gated rendering and submission", async () => {
		const d1 = db;
		const owner = syntheticId("synthetic-respondent-gate-owner");
		await createTestOwner(owner, syntheticEmail("gate-owner"));
		const service = new FormsService(db);
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
			emailProtectedSlug,
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
			`/api/forms/public/${emailProtectedSlug}/og.png`,
			{},
			env as never,
		);
		expect(og.status).toBe(200);
		expect(og.headers.get("cache-control")).toBe("no-store");
		expect(await og.text()).toBe("[]");
		const anonymousForm = await requestForms(
			`/api/forms/public/${emailProtectedSlug}`,
			{},
			env as never,
		);
		const anonymousData = (await anonymousForm.json()) as Record<string, any>;
		expect(anonymousData.requiresSignIn).toBe(true);
		expect(anonymousData.version.fields).toEqual([]);
		expect(anonymousData.form.confirmationMessage).toBeUndefined();
		expect(anonymousData.submissionToken).toBeUndefined();
		const bypass = await requestForms(
			`/api/forms/public/${emailProtectedSlug}/submit`,
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
		const d1 = db;
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
			const sent = await requestForms(
				"/api/auth/sign-in/magic-link",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: magicTestEmail,
						callbackURL: "/forms",
					}),
				},
				env as never,
			);
			expect(sent.status).toBe(200);
			expect(capturedTo).toContain(magicTestEmail);
			const match = /href="([^"]+)"/.exec(capturedHtml);
			expect(match).not.toBeNull();
			const signInUrl = new URL((match![1] ?? "").replace(/&amp;/g, "&"));
			const verified = await requestForms(
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
			const dashboard = await requestForms(
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
				const createdForPagination = await requestForms(
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
			const firstPageResponse = await requestForms(
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
			const secondPageResponse = await requestForms(
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
			const thirdPageResponse = await requestForms(
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
				const invalid = await requestForms(
					`/api/forms?${query}`,
					{ headers: { cookie: sessionCookie! } },
					env as never,
				);
				expect(invalid.status).toBe(400);
				expect(await invalid.json()).toMatchObject({ error: "INVALID_LIMIT" });
			}
			const invalidCursor = await requestForms(
				"/api/forms?cursor=not-a-valid-cursor",
				{ headers: { cookie: sessionCookie! } },
				env as never,
			);
			expect(invalidCursor.status).toBe(400);
			expect(await invalidCursor.json()).toMatchObject({
				error: "INVALID_CURSOR",
			});
			const respondentOwner = syntheticId(
				"synthetic-respondent-authorized-owner",
			);
			await createTestOwner(
				respondentOwner,
				syntheticEmail("authorized-owner"),
			);
			const respondentForm = await new FormsService(db).create(
				respondentOwner,
				{
					title: "Verified response",
					accent: "pink",
					fields: [
						{ id: "answer", type: "short", label: "Answer", required: true },
					],
				},
			);
			await new FormsService(db).publish(
				respondentOwner,
				respondentForm!.form!.id,
				verifiedResponseSlug,
				"https://forms.example.invalid",
				"https://s.example.invalid",
				"verified_email",
			);
			const anonRead = await requestForms(
				`/api/forms/public/${verifiedResponseSlug}`,
				{ headers: { "x-urlx-client-ip": "198.51.100.77" } },
				env as never,
			);
			const anonymousData = (await anonRead.json()) as {
				requiresSignIn?: boolean;
			};
			expect(anonymousData.requiresSignIn).toBe(true);
			const authorizedRead = await requestForms(
				`/api/forms/public/${verifiedResponseSlug}`,
				{
					headers: {
						cookie: sessionCookie!,
						"x-urlx-client-ip": "198.51.100.77",
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
			const respondentAccepted = await requestForms(
				`/api/forms/public/${verifiedResponseSlug}/submit`,
				{
					method: "POST",
					headers: {
						cookie: sessionCookie!,
						"x-urlx-client-ip": "198.51.100.77",
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
			const foreignOwner = syntheticId("synthetic-foreign-owner");
			await createTestOwner(foreignOwner, syntheticEmail("foreign"), "Foreign");
			const foreign = await new FormsService(db).create(foreignOwner, {
				title: "Private form",
				accent: "teal",
				fields: [],
			});
			const foreignId = foreign!.form!.id;
			const privateRequests = [
				requestForms(
					`/api/forms/${foreignId}`,
					{ headers: { cookie: sessionCookie! } },
					env as never,
				),
				requestForms(
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
				requestForms(
					`/api/forms/${foreignId}/publish`,
					{
						method: "POST",
						headers: {
							cookie: sessionCookie!,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							slug: syntheticSlug("foreign-private"),
							respondentAccess: "public",
						}),
					},
					env as never,
				),
				requestForms(
					`/api/forms/${foreignId}/responses`,
					{ headers: { cookie: sessionCookie! } },
					env as never,
				),
				requestForms(
					`/api/forms/${foreignId}/export.csv`,
					{ headers: { cookie: sessionCookie! } },
					env as never,
				),
				requestForms(
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
			const created = await requestForms(
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
			const saved = await requestForms(
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
			const missingAccessChoice = await requestForms(
				`/api/forms/${createdBody.form.id}/publish`,
				{
					method: "POST",
					headers: {
						cookie: sessionCookie!,
						"content-type": "application/json",
					},
					body: JSON.stringify({ slug: csvSlug }),
				},
				env as never,
			);
			expect(missingAccessChoice.status).toBe(400);
			expect(await missingAccessChoice.json()).toMatchObject({
				error: "RESPONDENT_ACCESS_REQUIRED",
			});
			const published = await requestForms(
				`/api/forms/${createdBody.form.id}/publish`,
				{
					method: "POST",
					headers: {
						cookie: sessionCookie!,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						slug: csvSlug,
						respondentAccess: "public",
					}),
				},
				env as never,
			);
			expect(published.status).toBe(200);
			const publicData = await requestForms(
				`/api/forms/public/${csvSlug}`,
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
			const accepted = await requestForms(
				`/api/forms/public/${csvSlug}/submit`,
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
			const exported = await requestForms(
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

			// Seed old published revisions directly; public submit behavior is covered above,
			// while one bounded setup keeps this CSV shape regression fast on capped CI Postgres.
			const history = Array.from({ length: 18 }, (_, index) => {
				const version = index + 3;
				const fields = Array.from({ length: 3 }, (_, fieldIndex) => ({
					id: `q${fieldIndex}`,
					type: "short",
					label: `Version ${version} question ${fieldIndex}`,
					required: false,
				}));
				return {
					version,
					versionId: crypto.randomUUID(),
					responseId: crypto.randomUUID(),
					idempotencyKey: crypto.randomUUID(),
					fieldsJson: JSON.stringify(fields),
					title: `CSV version ${version}`,
					answersJson: JSON.stringify(
						Object.fromEntries(
							fields.map((field) => [
								field.id,
								`answer-${version}-${field.id}`,
							]),
						),
					),
					createdAt: Date.now() + index,
				};
			});
			await db.$client.query(
				`INSERT INTO form_versions
					(id, form_id, version, fields_json, title, description, confirmation_message,
					 accent, respondent_access, created_at, published_at)
				 SELECT seed.version_id, $1, seed.version, seed.fields_json, seed.title,
					NULL, NULL, 'blue', 'public', seed.created_at, seed.created_at
				 FROM unnest($2::text[], $3::integer[], $4::text[], $5::text[], $6::bigint[])
				 AS seed(version_id, version, fields_json, title, created_at)`,
				[
					createdBody.form.id,
					history.map((row) => row.versionId),
					history.map((row) => row.version),
					history.map((row) => row.fieldsJson),
					history.map((row) => row.title),
					history.map((row) => row.createdAt),
				],
			);
			await db.$client.query(
				`INSERT INTO form_responses
					(id, form_id, version_id, idempotency_key, answers_json, created_at)
				 SELECT seed.response_id, $1, seed.version_id, seed.idempotency_key,
					seed.answers_json, seed.created_at
				 FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[])
				 AS seed(response_id, version_id, idempotency_key, answers_json, created_at)`,
				[
					createdBody.form.id,
					history.map((row) => row.responseId),
					history.map((row) => row.versionId),
					history.map((row) => row.idempotencyKey),
					history.map((row) => row.answersJson),
					history.map((row) => row.createdAt),
				],
			);
			const manyVersionExport = await requestForms(
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

	it("rejects NUL in passwordless profile fields before side effects while preserving escaped text", async () => {
		const env = {
			DB: db,
			FORMS_ENABLED: true,
			BETTER_AUTH_SECRET: "synthetic-auth-null-input-secret-not-for-deployment",
			BETTER_AUTH_URL: "https://forms.example.invalid",
			RESEND_API_KEY: "re_test_not_sent",
			AUTH_EMAIL_FROM: "URLX <forms@example.invalid>",
		};
		let capturedHtml = "";
		let mailRequests = 0;
		vi.stubGlobal(
			"fetch",
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				mailRequests++;
				const payload = JSON.parse(String(init?.body ?? "{}")) as {
					html?: string;
				};
				capturedHtml = payload.html ?? "";
				return new Response(
					JSON.stringify({ id: "synthetic-auth-null-email" }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		);
		try {
			const invalid = await requestForms(
				"/api/auth/sign-in/magic-link",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: authNullInputEmail,
						name: "bad\0name",
					}),
				},
				env as never,
			);
			expect(invalid.status).toBe(400);
			expect(mailRequests).toBe(0);
			const invalidVerification = await db.$client.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM verification WHERE identifier LIKE 'magic-link:%' AND value LIKE $1",
				[`%"email":"${authNullInputEmail}"%`],
			);
			expect(invalidVerification.rows[0]?.count).toBe(0);

			const acceptedName = "Normal\\u0000Name";
			const sent = await requestForms(
				"/api/auth/sign-in/magic-link",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: authNullInputEmail,
						name: acceptedName,
					}),
				},
				env as never,
			);
			expect(sent.status).toBe(200);
			expect(mailRequests).toBe(1);
			const link = /href="([^"]+)"/.exec(capturedHtml)?.[1];
			expect(link).toBeTruthy();
			const signInUrl = new URL(link!.replace(/&amp;/g, "&"));
			const verified = await requestForms(
				`${signInUrl.pathname}${signInUrl.search}`,
				{ method: "GET", redirect: "manual" },
				env as never,
			);
			expect(verified.status).toBe(302);
			const cookie = /(?:__Secure-)?urlx-forms\.session_token=[^;,]+/.exec(
				verified.headers.get("set-cookie") ?? "",
			)?.[0];
			expect(cookie).toBeTruthy();

			const rejectUpdate = (body: { name?: string; image?: string | null }) =>
				requestForms(
					"/api/auth/update-user",
					{
						method: "POST",
						headers: {
							cookie: cookie!,
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
					},
					env as never,
				);
			expect((await rejectUpdate({ name: "new\0name" })).status).toBe(400);
			expect(
				(await rejectUpdate({ image: "https://example.invalid/a\0b" })).status,
			).toBe(400);
			const rejectedRevoke = await requestForms(
				"/api/auth/revoke-session",
				{
					method: "POST",
					headers: {
						cookie: cookie!,
						"content-type": "application/json",
					},
					body: JSON.stringify({ token: "bad\0session-token" }),
				},
				env as never,
			);
			expect(rejectedRevoke.status).toBe(400);

			const invalidPublicSlug = await requestForms(
				`/api/forms/public/${encodeURIComponent("bad\0slug")}`,
				{},
				env as never,
			);
			expect(invalidPublicSlug.status).toBe(404);
			const invalidPublicSubmission = await requestForms(
				`/api/forms/public/${encodeURIComponent("bad\0slug")}/submit`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ answers: {} }),
				},
				env as never,
			);
			expect(invalidPublicSubmission.status).toBe(404);
			expect(await invalidPublicSubmission.json()).toMatchObject({
				error: "FORM_NOT_FOUND",
			});

			const invalidFormId = await requestForms(
				`/api/forms/${encodeURIComponent("bad\0id")}`,
				{ headers: { cookie: cookie! } },
				env as never,
			);
			expect(invalidFormId.status).toBe(404);

			const encodedCursor = btoa(
				JSON.stringify({ updatedAt: Date.now(), id: "bad\0id", search: "" }),
			)
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/g, "");
			const invalidCursor = await requestForms(
				`/api/forms?cursor=${encodedCursor}`,
				{ headers: { cookie: cookie! } },
				env as never,
			);
			expect(invalidCursor.status).toBe(400);
			expect(await invalidCursor.json()).toMatchObject({
				error: "INVALID_CURSOR",
			});

			const invalidSearch = await requestForms(
				`/api/forms?${new URLSearchParams({ search: "bad\0search" })}`,
				{ headers: { cookie: cookie! } },
				env as never,
			);
			expect(invalidSearch.status).toBe(400);
			expect(await invalidSearch.json()).toMatchObject({
				error: "INVALID_SEARCH",
			});

			const created = await requestForms(
				"/api/forms",
				{
					method: "POST",
					headers: {
						cookie: cookie!,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						template: "blank",
						title: "NUL selector test",
					}),
				},
				env as never,
			);
			expect(created.status).toBe(201);
			const createdForm = (await created.json()) as { form: { id: string } };
			const invalidResponseId = await requestForms(
				`/api/forms/${createdForm.form.id}/responses/${encodeURIComponent("bad\0response")}`,
				{ method: "DELETE", headers: { cookie: cookie! } },
				env as never,
			);
			expect(invalidResponseId.status).toBe(404);
			expect(await invalidResponseId.json()).toMatchObject({
				error: "FORM_NOT_FOUND",
			});

			const profile = await db.$client.query<{
				name: string;
				image: string | null;
			}>(' SELECT name, image FROM "user" WHERE email = $1', [
				authNullInputEmail,
			]);
			expect(profile.rows[0]).toEqual({ name: acceptedName, image: null });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
