import {
	parseBrowserRendererEnv,
	waitForEgressPolicyReadyFile,
} from "@urlx/env/server";
import { createRendererApp } from "./app";
import { launchRenderer } from "./render";

const env = parseBrowserRendererEnv(process.env);
await waitForEgressPolicyReadyFile(
	env.EGRESS_POLICY_READY_FILE,
	"conversion-renderer",
);
const renderer = await launchRenderer({
	proxyUrl: env.EGRESS_PROXY_URL,
	concurrency: env.RENDERER_CONCURRENCY,
	maxQueue: env.RENDERER_MAX_QUEUE,
	queueTimeoutMs: env.RENDERER_QUEUE_TIMEOUT_MS,
});
const app = createRendererApp(renderer);
const server = Bun.serve({
	port: env.PORT,
	hostname: "0.0.0.0",
	fetch: app.fetch,
});
console.info(
	`Conversion renderer listening on ${server.hostname}:${server.port}`,
);

let shuttingDown = false;
const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	await server.stop();
	await renderer.close();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
