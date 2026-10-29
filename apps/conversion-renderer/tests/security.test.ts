import { describe, expect, it, vi } from "vitest";
import { createRendererApp } from "../src/app";
import {
	createResourceBudget,
	guardRendererRoute,
	isUnsafeRequestUrl,
	type RenderInput,
	requireRendererProxyUrl,
	toMarkdown,
} from "../src/render";

describe("isolated conversion renderer security boundary", () => {
	it("fails closed unless the named proxy is configured", () => {
		expect(() => requireRendererProxyUrl(undefined)).toThrow(/required/);
		expect(() => requireRendererProxyUrl("http://127.0.0.1:3128")).toThrow();
		expect(requireRendererProxyUrl("http://egress-proxy:3128")).toBe(
			"http://egress-proxy:3128",
		);
	});

	it.each([
		"http://localhost/",
		"http://127.0.0.1:3100/healthz",
		"http://169.254.169.254/latest/meta-data/",
		"http://10.20.0.3/",
		"http://[::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[fe80::1]/",
		"http://database/",
		"http://2130706433/",
		"http://0x7f000001/",
		"http://255.255.255.255/",
		"file:///etc/passwd",
	])("blocks unsafe browser destination %s", (url) => {
		expect(isUnsafeRequestUrl(url)).toBe(true);
	});

	it.each(["https://example.com/path", "http://93.184.216.34/"])(
		"allows public HTTP destination %s",
		(url) => expect(isUnsafeRequestUrl(url)).toBe(false),
	);

	it("applies URL and resource checks to navigations, redirects, private iframes, and subresources", async () => {
		const abort = vi.fn(async () => undefined);
		const proceed = vi.fn(async () => undefined);
		const makeRoute = (url: string, type = "document") =>
			({
				request: () => ({ url: () => url, resourceType: () => type }),
				abort,
				continue: proceed,
			}) as never;
		await guardRendererRoute(makeRoute("https://example.com/start"), new Set());
		await guardRendererRoute(
			makeRoute("http://127.0.0.1/admin", "document"), // browser followed a redirect
			new Set(),
		);
		await guardRendererRoute(
			makeRoute("http://conversion-renderer:3100/healthz", "document"),
			new Set(),
		);
		await guardRendererRoute(
			makeRoute("http://192.168.1.5/frame", "document"), // private iframe
			new Set(),
		);
		await guardRendererRoute(
			makeRoute("http://[::ffff:127.0.0.1]/pixel.png", "image"),
			new Set(["image"]),
		);
		await guardRendererRoute(
			makeRoute("http://169.254.169.254/latest/meta-data", "xhr"),
			new Set(),
		);
		expect(proceed).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(5);
	});

	it("blocks workers, server-sent events, and non-main-frame documents", async () => {
		const abort = vi.fn(async () => undefined);
		const proceed = vi.fn(async () => undefined);
		const mainFrame = {};
		const page = { mainFrame: () => mainFrame } as never;
		const makeRoute = (
			url: string,
			options: { accept?: string; frame?: object } = {},
		) =>
			({
				request: () => ({
					url: () => url,
					resourceType: () => "document",
					headers: () => ({ accept: options.accept ?? "text/html" }),
					frame: () => options.frame ?? mainFrame,
				}),
				abort,
				continue: proceed,
			}) as never;
		await guardRendererRoute(
			makeRoute("https://example.com/stream", { accept: "text/event-stream" }),
			new Set(),
			{ page },
		);
		await guardRendererRoute(
			makeRoute("https://example.com/frame", { frame: {} }),
			new Set(),
			{ page },
		);
		expect(abort).toHaveBeenCalledTimes(2);
		expect(proceed).not.toHaveBeenCalled();
	});

	it("caps request count, per-resource bytes, and cumulative decoded/encoded transfer", () => {
		const onExceeded = vi.fn();
		const budget = createResourceBudget("html", onExceeded);
		for (let index = 0; index < 128; index++) budget.requestStarted();
		expect(onExceeded).not.toHaveBeenCalled();
		budget.requestStarted();
		expect(onExceeded).toHaveBeenCalledTimes(1);

		const perResourceFailure = vi.fn();
		const perResource = createResourceBudget("html", perResourceFailure);
		perResource.responseReceived("large", {
			"content-length": String(4 * 1024 * 1024 + 1),
		});
		expect(perResourceFailure).toHaveBeenCalledTimes(1);

		const cumulativeFailure = vi.fn();
		const cumulative = createResourceBudget("html", cumulativeFailure);
		for (let index = 0; index < 6; index++) {
			const id = String(index);
			cumulative.responseReceived(id, {});
			cumulative.dataReceived(id, 3 * 1024 * 1024, 1024 * 1024);
		}
		expect(cumulativeFailure).toHaveBeenCalledTimes(1);
	});

	it("keeps meaningful Markdown structure with the GFM renderer", () => {
		const html = `<h1>Release notes</h1><p>Read <a href="https://example.com/guide">the guide</a>.</p><ul><li>One</li><li>Two</li></ul><blockquote><p>Keep this quote.</p></blockquote><pre><code class="language-js">const x = 1;</code></pre><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Count</td><td>3</td></tr></tbody></table>`;
		const markdown = toMarkdown(html);
		expect(markdown).toContain("# Release notes");
		expect(markdown).toContain("[the guide](https://example.com/guide)");
		expect(markdown).toContain("-   One\n-   Two");
		expect(markdown).toContain("> Keep this quote.");
		expect(markdown).toContain("```js\nconst x = 1;\n```");
		expect(markdown).toContain("| Name | Value |");
	});

	it("bounds the internal renderer request and rejects extra input properties", async () => {
		const render = vi.fn(async (_input: RenderInput) => "safe output");
		const app = createRendererApp({ render } as never);
		const extra = await app.request("/render", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				url: "https://example.com",
				format: "html",
				headers: { x: "y" },
			}),
		});
		expect(extra.status).toBe(400);
		expect(render).not.toHaveBeenCalled();

		const oversized = await app.request("/render", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				url: `https://example.com/${"x".repeat(5000)}`,
				format: "html",
			}),
		});
		expect(oversized.status).toBe(400);
		expect(render).not.toHaveBeenCalled();
	});
});
