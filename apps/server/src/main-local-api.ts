import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { createPgDb, createPgPool } from "@urlx/db";
import { apiApp } from "./index";
import type { ApiAppBindings } from "./runtime/bindings";
import { assertApiDatabaseRole } from "./runtime/database-role";
import { createLocalDevRuntime } from "./runtime/local-dev-runtime";

if (
	process.env.NODE_ENV !== "development" ||
	process.env.URLX_LOCAL_PREVIEW !== "true"
) {
	throw new Error(
		"Native API requires NODE_ENV=development and URLX_LOCAL_PREVIEW=true",
	);
}

const port = 8787;
const webOrigin = process.env.URLX_LOCAL_WEB_ORIGIN ?? "http://127.0.0.1:4321";
if (
	!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(webOrigin) ||
	new URL(webOrigin).hostname !== "127.0.0.1"
)
	throw new Error("Native API CORS origin must be a loopback web origin");
const apiOrigin = `http://127.0.0.1:${port}`;
const databaseUrl = new URL(required("DATABASE_URL"));
if (
	!/^postgres(?:ql)?:$/.test(databaseUrl.protocol) ||
	!["127.0.0.1", "localhost", "::1"].includes(databaseUrl.hostname) ||
	databaseUrl.port !== "5433" ||
	databaseUrl.username !== "urlx_app" ||
	databaseUrl.pathname !== "/urlx_local"
) {
	throw new Error(
		"Native API requires the isolated loopback urlx_local database on port 5433",
	);
}

const pool = createPgPool(databaseUrl.toString(), { max: 5 });
try {
	await assertApiDatabaseRole(pool);
} catch {
	await pool.end().catch(() => undefined);
	throw new Error(
		"Native API startup requires restricted urlx_app database role",
	);
}

const keyMaterial = process.env.URLX_LOCAL_PREVIEW_KEY;
if (!keyMaterial || keyMaterial.length < 32)
	throw new Error("Native API preview key is missing or invalid");
const authSecret = process.env.URLX_LOCAL_AUTH_SECRET;
if (
	!authSecret ||
	new TextEncoder().encode(authSecret).byteLength < 32 ||
	/^(.)\1{31,}$/su.test(authSecret)
)
	throw new Error("Native API preview auth secret is missing or invalid");
const local = createLocalDevRuntime(keyMaterial);
const visitorKey = randomBytes(32);
const visitorTokenKey = await crypto.subtle.importKey(
	"raw",
	visitorKey,
	{ name: "HMAC", hash: "SHA-256" },
	false,
	["sign", "verify"],
);
const captureDirectory = resolve(required("URLX_LOCAL_PREVIEW_DIR"));
const privateRoot = resolve(process.env.LOCALAPPDATA ?? "");
const captureParts = privateRoot
	? relative(privateRoot, captureDirectory).split(sep)
	: [];
if (
	!privateRoot ||
	captureParts.length !== 3 ||
	captureParts[0] !== "URLX-local-preview" ||
	captureParts[1] !== "runs" ||
	!/^run-[a-f0-9]{32}$/i.test(captureParts[2] ?? "")
)
	throw new Error(
		"Native API capture directory must be a fresh private local preview run directory",
	);
const capturePath = resolve(captureDirectory, "magic-link.json");
await mkdir(captureDirectory, { recursive: true });

// Resend's SDK uses fetch. The native preview intercepts only its exact
// endpoint, permits one synthetic address, stores the one-time URL privately,
// and rejects every other outbound request without a network fallback.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const request = input instanceof Request ? input : new Request(input, init);
	const target = new URL(request.url);
	if (
		target.origin !== "https://api.resend.com" ||
		target.pathname !== "/emails" ||
		request.method !== "POST"
	)
		throw new Error("Outbound network is disabled in native local preview");
	const payload = (await request.json()) as {
		to?: string | string[];
		html?: string;
	};
	const recipients = Array.isArray(payload.to) ? payload.to : [payload.to];
	if (
		recipients.length !== 1 ||
		recipients[0] !== "local-preview@example.invalid"
	)
		throw new Error(
			"Native preview mail is limited to local-preview@example.invalid",
		);
	const href = payload.html
		?.match(/href="(https?:[^"]+)"/i)?.[1]
		?.replaceAll("&amp;", "&");
	if (
		!href ||
		new URL(href).origin !== webOrigin ||
		!new URL(href).pathname.startsWith("/api/auth/")
	)
		throw new Error("Native preview received an invalid magic link");
	await writeFile(
		capturePath,
		JSON.stringify({ url: href, createdAt: new Date().toISOString() }),
		{ mode: 0o600 },
	);
	return Response.json({ id: "local-preview-captured" }, { status: 200 });
}) as typeof fetch;

const db = createPgDb(pool);
const unavailableMetadataFetcher: ApiAppBindings["METADATA_FETCHER"] =
	async () => {
		throw new Error("Metadata fetching is disabled in native local preview");
	};
const bindings: ApiAppBindings = {
	DB: db,
	AUTH_SECONDARY_STORAGE: local.authStorage,
	VISITOR_TOKEN_KEY: visitorTokenKey,
	CORS_ORIGIN: webOrigin,
	METADATA_FETCHER: unavailableMetadataFetcher,
	METADATA_IP_RATE_LIMIT: local.limiters.metadataIp,
	METADATA_VISITOR_RATE_LIMIT: local.limiters.metadataVisitor,
	FORMS_RENDER_RATE_LIMIT: local.limiters.formsRender,
	FORMS_SUBMIT_RATE_LIMIT: local.limiters.formsSubmit,
	FORMS_ENABLED: true,
	BETTER_AUTH_SECRET: authSecret,
	BETTER_AUTH_URL: `${webOrigin}/api/auth`,
	RESEND_API_KEY: "local-preview-only",
	AUTH_EMAIL_FROM: "URLX Local Preview <local-preview@example.invalid>",
};
const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch: (request) => apiApp.fetch(request, bindings),
});
console.info(`Native local API listening at ${apiOrigin}`);

let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	await server.stop();
	await pool.end();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing local preview setting ${name}`);
	return value;
}
