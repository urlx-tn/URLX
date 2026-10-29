import { conversionApp } from "./conversion";
import { createConversionRendererClient } from "./lib/conversion-renderer-client";
import type { ConversionAppBindings } from "./runtime/bindings";
import { createLocalDevRuntime } from "./runtime/local-dev-runtime";

if (
	process.env.NODE_ENV !== "development" ||
	process.env.URLX_LOCAL_PREVIEW !== "true"
) {
	throw new Error(
		"Native local conversion API requires NODE_ENV=development and URLX_LOCAL_PREVIEW=true",
	);
}

const port = 8788;
const webOrigin = process.env.URLX_LOCAL_WEB_ORIGIN ?? "http://127.0.0.1:4321";
if (
	!/^http:\/\/127\.0\.0\.1:\d+$/.test(webOrigin) ||
	new URL(webOrigin).hostname !== "127.0.0.1"
)
	throw new Error("Native local conversion API requires a loopback web origin");

const visitorTokenKeyBase64 = requiredSecret("URLX_LOCAL_VISITOR_TOKEN_KEY");
const visitorTokenKeyBytes = Buffer.from(visitorTokenKeyBase64, "base64");
if (
	visitorTokenKeyBytes.byteLength !== 32 ||
	visitorTokenKeyBytes.toString("base64") !== visitorTokenKeyBase64
)
	throw new Error(
		"URLX_LOCAL_VISITOR_TOKEN_KEY must be canonical base64 for 32 bytes",
	);

const rendererToken = requiredSecret("URLX_LOCAL_RENDERER_TOKEN");
const local = createLocalDevRuntime(visitorTokenKeyBase64);
const visitorTokenKey = await crypto.subtle.importKey(
	"raw",
	visitorTokenKeyBytes,
	{ name: "HMAC", hash: "SHA-256" },
	false,
	["sign", "verify"],
);

const browserRenderer = createConversionRendererClient({
	baseUrl: "http://conversion-renderer:3100",
	keyMaterial: visitorTokenKeyBase64,
	fetcher: remapRendererRequest,
});

const bindings: ConversionAppBindings = {
	BROWSER_RENDERER: browserRenderer,
	CONVERSION_IP_RATE_LIMIT: local.limiters.conversionIp,
	CONVERSION_VISITOR_RATE_LIMIT: local.limiters.conversionVisitor,
	CORS_ORIGIN: webOrigin,
	VISITOR_TOKEN_KEY: visitorTokenKey,
};

const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch: (request) => conversionApp.fetch(request, bindings),
});
console.info(
	`Native local conversion API listening at http://127.0.0.1:${port}`,
);

let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	await server.stop();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

async function remapRendererRequest(
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	let target: URL;
	try {
		target = new URL(input instanceof Request ? input.url : String(input));
	} catch {
		throw new Error("Unexpected renderer request target");
	}
	if (
		target.protocol !== "http:" ||
		target.hostname !== "conversion-renderer" ||
		target.port !== "3100" ||
		target.pathname !== "/render" ||
		target.username ||
		target.password ||
		target.search ||
		target.hash
	)
		throw new Error("Unexpected renderer request target");

	const request = input instanceof Request ? input : undefined;
	const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
	if (method !== "POST") throw new Error("Unexpected renderer request method");
	const headers = new Headers(request?.headers);
	new Headers(init?.headers).forEach((value, name) => {
		headers.set(name, value);
	});
	headers.set("Authorization", `Bearer ${rendererToken}`);
	const body = init?.body ?? request?.body;
	const localRequest: RequestInit & { proxy: false } = {
		method,
		headers,
		body,
		signal: init?.signal ?? request?.signal,
		redirect: "manual",
		proxy: false,
		...(body ? { duplex: "half" as const } : {}),
	};
	return fetch("http://127.0.0.1:8790/render", localRequest);
}

function requiredSecret(name: string) {
	const value = process.env[name];
	if (!value || value.length < 32 || /[\r\n]/.test(value))
		throw new Error(`${name} is missing or invalid`);
	return value;
}
