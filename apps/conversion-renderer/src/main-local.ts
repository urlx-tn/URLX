import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { chromium } from "playwright";
import { createRendererApp } from "./app";
import { PlaywrightRenderer } from "./render";

if (
	process.env.NODE_ENV !== "development" ||
	process.env.URLX_LOCAL_PREVIEW !== "true"
) {
	throw new Error(
		"Native local renderer requires NODE_ENV=development and URLX_LOCAL_PREVIEW=true",
	);
}

const port = 8790;
const proxyUrl = "http://127.0.0.1:8789";
const proxyToken = requiredSecret("URLX_LOCAL_PROXY_TOKEN");
const rendererToken = requiredSecret("URLX_LOCAL_RENDERER_TOKEN");

const browser = await chromium.launch({
	headless: true,
	chromiumSandbox: true,
	proxy: {
		server: proxyUrl,
		username: "urlx-local",
		password: proxyToken,
		bypass: "",
	},
	args: [
		"--proxy-bypass-list=<-loopback>",
		"--disable-quic",
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
	],
});
const renderer = new PlaywrightRenderer(browser, {
	proxyUrl,
	concurrency: 2,
	maxQueue: 8,
	queueTimeoutMs: 5_000,
});

const app = new Hono();
app.use("/render", async (c, next) => {
	if (!matchesBearerToken(c.req.header("authorization"), rendererToken)) {
		return c.json({ code: "UNAUTHORIZED" }, 401, {
			"Cache-Control": "no-store",
		});
	}
	await next();
});
app.route("/", createRendererApp(renderer));

const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch: app.fetch,
});
console.info(`Native local renderer listening at http://127.0.0.1:${port}`);

let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	await server.stop();
	await renderer.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

function requiredSecret(name: string) {
	const value = process.env[name];
	if (!value || value.length < 32 || /[\r\n]/.test(value))
		throw new Error(`${name} is missing or invalid`);
	return value;
}

function matchesBearerToken(header: string | undefined, token: string) {
	if (!header?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(token);
	return (
		supplied.byteLength === expected.byteLength &&
		timingSafeEqual(supplied, expected)
	);
}
