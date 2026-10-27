import {
	parseConversionServerEnv,
	waitForEgressPolicyReadyFile,
} from "@urlx/env/server";
import { conversionApp } from "./conversion";
import {
	createConversionRendererClient,
	createUnavailableConversionRenderer,
} from "./lib/conversion-renderer-client";
import type { ConversionAppBindings } from "./runtime/bindings";
import { createValkeyRuntime, waitForValkey } from "./runtime/valkey";

const env = parseConversionServerEnv(process.env);
await waitForEgressPolicyReadyFile(env.EGRESS_POLICY_READY_FILE, "conversion");
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
const bindings: ConversionAppBindings = {
	BROWSER_RENDERER:
		env.CONVERSION_BROWSER_DISABLED === "true"
			? createUnavailableConversionRenderer()
			: createConversionRendererClient({
					baseUrl: env.BROWSER_RENDERER_URL ?? "",
					keyMaterial: env.VISITOR_TOKEN_KEY_BASE64,
					cache: {
						get: (key) => valkey.client.get(key),
						set: (key, value, ttlSeconds) =>
							valkey.client.set(key, value, "EX", ttlSeconds),
					},
				}),
	CONVERSION_IP_RATE_LIMIT: valkey.limiters.conversionIp,
	CONVERSION_VISITOR_RATE_LIMIT: valkey.limiters.conversionVisitor,
	CORS_ORIGIN: env.CORS_ORIGIN,
	VISITOR_TOKEN_KEY: visitorTokenKey,
};
const server = Bun.serve({
	port: env.PORT,
	hostname: "0.0.0.0",
	fetch: (request) => conversionApp.fetch(request, bindings),
});
console.info(
	`Conversion server listening on ${server.hostname}:${server.port}`,
);

let shuttingDown = false;
const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	await server.stop();
	await valkey.client.quit().catch(() => valkey.client.disconnect());
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
