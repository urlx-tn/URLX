/** Direct loopback harness; it does not validate the production Squid/firewall egress boundary. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createRendererApp } from "../src/app";
import { PlaywrightRenderer, requireRendererProxyUrl } from "../src/render";

const host = "urlx-public.test";
let fixture!: ReturnType<typeof Bun.serve>;
let privateHits = 0;
let slowHitResolve: (() => void) | undefined;
const slowHit = new Promise<void>((resolve) => {
	slowHitResolve = resolve;
});
const fixturePage = `<!doctype html><html><body><script>
	document.body.dataset.context = localStorage.getItem("marker") || "clean";
	localStorage.setItem("marker", "used");
	document.body.innerHTML = "<h1>Rendered by JavaScript</h1>";
</script></body></html>`;

fixture = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 60,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/private") {
			privateHits += 1;
			return new Response("must not reach private target");
		}
		if (url.pathname === "/redirect-private")
			return new Response(null, {
				status: 302,
				headers: {
					location: `http://127.0.0.1:${fixture.port}/private`,
				},
			});
		if (url.pathname === "/redirect-public")
			return Response.redirect(base("/assets-page"), 302);
		if (url.pathname === "/assets-page")
			return new Response(
				`<!doctype html><body><h1>Final ${url.pathname}</h1><script src="/asset.js"></script></body>`,
				{ headers: { "content-type": "text/html" } },
			);
		if (url.pathname === "/asset.js")
			return new Response(
				`document.body.insertAdjacentHTML("beforeend", "<strong>redirect asset loaded</strong>")`,
				{ headers: { "content-type": "text/javascript" } },
			);
		if (url.pathname === "/multi-hop-start")
			return Response.redirect(base("/public-hop-to-private"), 302);
		if (url.pathname === "/public-hop-to-private")
			return new Response(null, {
				status: 302,
				headers: {
					location: `http://127.0.0.1:${fixture.port}/private`,
				},
			});
		if (url.pathname === "/redirect-subresource")
			return new Response(
				`<!doctype html><body><script>void fetch("/subresource-hop")</script></body>`,
				{ headers: { "content-type": "text/html" } },
			);
		if (url.pathname === "/subresource-hop")
			return new Response(null, {
				status: 302,
				headers: {
					location: `http://127.0.0.1:${fixture.port}/private`,
				},
			});
		if (url.pathname === "/private-iframe")
			return new Response(
				`<!doctype html><body><iframe src="http://127.0.0.1:${fixture.port}/private"></iframe></body>`,
				{ headers: { "content-type": "text/html" } },
			);
		if (url.pathname === "/private-popup")
			return new Response(
				`<!doctype html><body><script>window.open("http://127.0.0.1:${fixture.port}/private")</script></body>`,
				{ headers: { "content-type": "text/html" } },
			);
		if (url.pathname === "/large")
			return new Response("x".repeat(4 * 1024 * 1024 + 1), {
				headers: {
					"content-type": "text/plain",
					"content-length": String(4 * 1024 * 1024 + 1),
				},
			});
		if (url.pathname === "/blob")
			return new Response("x".repeat(3 * 1024 * 1024), {
				headers: { "content-type": "text/plain" },
			});
		if (url.pathname === "/transfer")
			return new Response(
				`<!doctype html><body><script>void Promise.all(Array.from({length:6},(_,i)=>fetch('/blob?n='+i)))</script></body>`,
				{ headers: { "content-type": "text/html" } },
			);
		if (url.pathname === "/requests")
			return new Response(
				`<!doctype html><body><script>void Promise.all(Array.from({length:140},(_,i)=>fetch('/tiny?n='+i)))</script></body>`,
				{ headers: { "content-type": "text/html" } },
			);
		if (url.pathname === "/redirect-budget")
			return new Response(
				`<!doctype html><body><script>void Promise.all(Array.from({length:7},(_,i)=>fetch('/redirect-budget-start?chain='+i)))</script></body>`,
				{ headers: { "content-type": "text/html" } },
			);
		if (url.pathname === "/redirect-budget-start") {
			const chain = url.searchParams.get("chain") ?? "0";
			return Response.redirect(
				base(`/redirect-budget-step?chain=${chain}&step=0`),
				302,
			);
		}
		if (url.pathname === "/redirect-budget-step") {
			const chain = url.searchParams.get("chain") ?? "0";
			const step = Number(url.searchParams.get("step") ?? 0);
			if (step >= 24) return new Response("done");
			return Response.redirect(
				base(`/redirect-budget-step?chain=${chain}&step=${step + 1}`),
				302,
			);
		}
		if (url.pathname === "/tiny") return new Response("ok");
		if (url.pathname === "/slow") {
			slowHitResolve?.();
			await new Promise((resolve) => setTimeout(resolve, 800));
		}
		if (url.pathname === "/stall") return await new Promise<Response>(() => {});
		return new Response(fixturePage, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
});

const base = (path = "/") => `http://${host}:${fixture.port}${path}`;
const startRendererServer = (renderer: PlaywrightRenderer) =>
	Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: createRendererApp(renderer).fetch,
	});
const render = (
	port: number,
	url: string,
	format: "html" | "markdown" = "html",
) =>
	fetch(`http://127.0.0.1:${port}/render`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ url, format }),
	});

const failures: string[] = [];
async function check(name: string, run: () => Promise<void>) {
	try {
		await run();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures.push(name);
		console.error(`FAIL ${name}`, error);
	}
}

try {
	assert.equal(
		requireRendererProxyUrl("http://egress-proxy:3128"),
		"http://egress-proxy:3128",
	);
	assert.throws(() => requireRendererProxyUrl("http://127.0.0.1:3128"));
	const launchArgs = [`--host-resolver-rules=MAP ${host} 127.0.0.1`];
	const browser = await chromium.launch({
		headless: true,
		chromiumSandbox: true,
		args: launchArgs,
	});
	const renderer = new PlaywrightRenderer(browser, {
		proxyUrl: "http://egress-proxy:3128",
		concurrency: 2,
		maxQueue: 2,
		queueTimeoutMs: 100,
	});
	const server = startRendererServer(renderer);
	try {
		await check(
			"renders JavaScript-backed HTML through the HTTP endpoint",
			async () => {
				const response = await render(server.port, base());
				assert.equal(response.status, 200);
				const body = (await response.json()) as { result: string };
				assert.match(body.result, /Rendered by JavaScript/);
				assert.match(body.result, /data-context="clean"/);
			},
		);
		await check("extracts rendered DOM as Markdown", async () => {
			const response = await render(server.port, base(), "markdown");
			assert.equal(response.status, 200);
			const body = (await response.json()) as { result: string };
			assert.match(body.result, /# Rendered by JavaScript/);
		});
		await check(
			"creates a fresh storage context for every render",
			async () => {
				const response = await render(server.port, base());
				const body = (await response.json()) as { result: string };
				assert.equal(response.status, 200);
				assert.match(body.result, /data-context="clean"/);
			},
		);
		await check(
			"rejects private targets and oversized HTTP request bodies",
			async () => {
				const privateTarget = await render(
					server.port,
					`http://127.0.0.1:${fixture.port}/`,
				);
				assert.equal(privateTarget.status, 400);
				assert.deepEqual(await privateTarget.json(), { code: "INVALID_URL" });
				const oversized = await fetch(
					`http://127.0.0.1:${server.port}/render`,
					{
						method: "POST",
						body: "x".repeat(5000),
						headers: { "content-type": "application/json" },
					},
				);
				assert.equal(oversized.status, 400);
				assert.deepEqual(await oversized.json(), {
					code: "INVALID_RENDER_REQUEST",
				});
			},
		);
		await check("blocks a top-level public-to-private redirect", async () => {
			const response = await render(server.port, base("/redirect-private"));
			assert.equal(response.status, 502);
			assert.deepEqual(await response.json(), { code: "PAGE_FETCH_FAILED" });
			assert.equal(privateHits, 0);
		});
		await check(
			"allows public redirects and their relative JavaScript assets",
			async () => {
				const response = await render(server.port, base("/redirect-public"));
				assert.equal(response.status, 200);
				const body = (await response.json()) as { result: string };
				assert.match(body.result, /Final \/assets-page/);
				assert.match(body.result, /redirect asset loaded/);
			},
		);
		await check("blocks a public-public-private navigation chain", async () => {
			const response = await render(server.port, base("/multi-hop-start"));
			assert.equal(response.status, 502);
			assert.deepEqual(await response.json(), { code: "PAGE_FETCH_FAILED" });
			assert.equal(privateHits, 0);
		});
		await check("blocks a private redirect from a subresource", async () => {
			const response = await render(server.port, base("/redirect-subresource"));
			assert.equal(response.status, 200);
			assert.equal(privateHits, 0);
		});
		await check("blocks an iframe navigation to a private target", async () => {
			const response = await render(server.port, base("/private-iframe"));
			assert.equal(response.status, 200);
			assert.equal(privateHits, 0);
		});
		await check("blocks a popup navigation to a private target", async () => {
			const response = await render(server.port, base("/private-popup"));
			assert.equal(response.status, 200);
			assert.equal(privateHits, 0);
		});
		await check(
			"enforces per-resource and cumulative transfer budgets",
			async () => {
				const large = await render(server.port, base("/large"));
				assert.equal(large.status, 413);
				assert.deepEqual(await large.json(), { code: "HTML_TOO_LARGE" });
				const cumulative = await render(server.port, base("/transfer"));
				assert.equal(cumulative.status, 413);
				assert.deepEqual(await cumulative.json(), { code: "HTML_TOO_LARGE" });
			},
		);
		await check("caps actual Chromium subresource request count", async () => {
			const response = await render(server.port, base("/requests"));
			assert.equal(response.status, 413);
			assert.deepEqual(await response.json(), { code: "HTML_TOO_LARGE" });
		});
		await check(
			"counts each Chromium redirect hop against the request cap",
			async () => {
				const response = await render(server.port, base("/redirect-budget"));
				assert.equal(response.status, 413);
				assert.deepEqual(await response.json(), { code: "HTML_TOO_LARGE" });
			},
		);
	} finally {
		await renderer.close();
		await server.stop(true);
	}

	const limited = new PlaywrightRenderer(
		await chromium.launch({
			headless: true,
			chromiumSandbox: true,
			args: launchArgs,
		}),
		{
			proxyUrl: "http://egress-proxy:3128",
			concurrency: 1,
			maxQueue: 1,
			queueTimeoutMs: 100,
		},
	);
	const queueServer = startRendererServer(limited);
	try {
		await check("applies the configured render queue timeout", async () => {
			const first = render(queueServer.port, base("/slow"));
			await Promise.race([
				slowHit,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("fixture not reached")), 2000),
				),
			]);
			const waiting = await render(queueServer.port, base());
			assert.equal(waiting.status, 503);
			assert.deepEqual(await waiting.json(), { code: "RENDERER_BUSY" });
			assert.equal((await first).status, 200);
		});
		await check(
			"returns a bounded error for a stalled navigation",
			async () => {
				const started = Date.now();
				const response = await render(queueServer.port, base("/stall"));
				const elapsed = Date.now() - started;
				assert.equal(response.status, 502);
				assert.deepEqual(await response.json(), { code: "PAGE_FETCH_FAILED" });
				assert.ok(
					elapsed >= 28_000 && elapsed < 36_000,
					`elapsed ${elapsed}ms`,
				);
				console.log(`INFO stalled navigation returned after ${elapsed} ms`);
			},
		);
	} finally {
		await limited.close();
		await queueServer.stop(true);
	}
} finally {
	await fixture.stop(true);
}

if (failures.length) process.exitCode = 1;
