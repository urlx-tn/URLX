import { createPgDb, createPgPool } from "@urlx/db";
import {
	parseApiServerEnv,
	waitForEgressPolicyReadyFile,
} from "@urlx/env/server";
import { apiApp } from "./index";
import { createProxyFetcher, requireEgressProxyUrl } from "./lib/proxy-fetch";
import type { ApiAppBindings } from "./runtime/bindings";
import { assertApiDatabaseRole } from "./runtime/database-role";
import { createValkeyRuntime, waitForValkey } from "./runtime/valkey";

const env = parseApiServerEnv(process.env);
const egressProxyUrl = requireEgressProxyUrl(env.EGRESS_PROXY_URL);
await waitForEgressPolicyReadyFile(env.EGRESS_POLICY_READY_FILE, "api");

process.env.HTTP_PROXY = egressProxyUrl;
process.env.HTTPS_PROXY = egressProxyUrl;
process.env.http_proxy = egressProxyUrl;
process.env.https_proxy = egressProxyUrl;
const internalNoProxy =
	"localhost,127.0.0.1,::1,api,conversion,conversion-renderer,egress-proxy,postgres,valkey,web";
process.env.NO_PROXY = internalNoProxy;
process.env.no_proxy = internalNoProxy;

const pool = createPgPool(env.DATABASE_URL, { max: env.PG_POOL_MAX });
try {
	await assertApiDatabaseRole(pool);
} catch {
	await pool.end().catch(() => undefined);
	console.error(
		"API startup refused: restricted urlx_app database role required",
	);
	process.exit(78);
}
const db = createPgDb(pool);
const valkey = createValkeyRuntime(
	env.VALKEY_URL,
	env.VISITOR_TOKEN_KEY_BASE64,
);
await waitForValkey(valkey.client);
const visitorTokenKey = await crypto.subtle.importKey(
	"raw",
	Buffer.from(env.VISITOR_TOKEN_KEY_BASE64, "base64"),
	{ name: "HMAC", hash: "SHA-256" },
	false,
	["sign", "verify"],
);

const bindings: ApiAppBindings = {
	DB: db,
	VISITOR_TOKEN_KEY: visitorTokenKey,
	CORS_ORIGIN: env.CORS_ORIGIN,
	SHORT_URL_BASE: env.SHORT_URL_BASE,
	METADATA_FETCHER: createProxyFetcher(egressProxyUrl),
	METADATA_IP_RATE_LIMIT: valkey.limiters.metadataIp,
	METADATA_VISITOR_RATE_LIMIT: valkey.limiters.metadataVisitor,
	FORMS_RENDER_RATE_LIMIT: valkey.limiters.formsRender,
	FORMS_SUBMIT_RATE_LIMIT: valkey.limiters.formsSubmit,
	AUTH_SECONDARY_STORAGE: valkey.authStorage,
	FORMS_ENABLED: env.FORMS_ENABLED,
	BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
	BETTER_AUTH_URL: env.BETTER_AUTH_URL,
	RESEND_API_KEY: env.RESEND_API_KEY,
	AUTH_EMAIL_FROM: env.AUTH_EMAIL_FROM,
};

const server = Bun.serve({
	port: env.PORT,
	hostname: "0.0.0.0",
	fetch: (request) => apiApp.fetch(request, bindings),
});
console.info(`API listening on ${server.hostname}:${server.port}`);

let shuttingDown = false;
const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	await server.stop();
	await valkey.client.quit().catch(() => valkey.client.disconnect());
	await pool.end();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
