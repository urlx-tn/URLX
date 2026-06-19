import { describe, expect, it, vi } from "vitest";

import { MarkdownError } from "./markdown.errors";
import { MarkdownService } from "./markdown.service";

const createBrowser = (response: Response | Error) => ({
	quickAction: vi.fn(async () => {
		if (response instanceof Error) {
			throw response;
		}

		return response;
	}),
});

const createRateLimiter = (success = true) => ({
	limit: vi.fn(async () => ({ success })),
});

const createService = (
	response: Response | Error,
	rateLimiter = createRateLimiter(),
) =>
	new MarkdownService({
		browser: createBrowser(response),
		rateLimiter,
		rateLimitKey: "test-client",
	});

describe("MarkdownService", () => {
	it("converts and normalizes a public URL", async () => {
		const browser = createBrowser(
			Response.json({
				success: true,
				result: "# Example\n\nConverted content.",
			}),
		);
		const rateLimiter = createRateLimiter();
		const service = new MarkdownService({
			browser,
			rateLimiter,
			rateLimitKey: "203.0.113.10",
		});

		await expect(
			service.convert(" HTTPS://Example.COM:443/page "),
		).resolves.toEqual({
			sourceUrl: "https://example.com/page",
			markdown: "# Example\n\nConverted content.",
		});
		expect(browser.quickAction).toHaveBeenCalledWith(
			"markdown",
			expect.objectContaining({
				url: "https://example.com/page",
				rejectResourceTypes: ["image", "media", "font", "stylesheet"],
				cacheTTL: 300,
			}),
		);
		expect(rateLimiter.limit).toHaveBeenCalledWith({
			key: "markdown:203.0.113.10",
		});
	});

	it("does not call Browser Run for blocked URLs", async () => {
		const browser = createBrowser(
			Response.json({ success: true, result: "unused" }),
		);
		const service = new MarkdownService({
			browser,
			rateLimiter: createRateLimiter(),
			rateLimitKey: "test-client",
		});

		await expect(service.convert("http://127.0.0.1")).rejects.toMatchObject({
			code: "PRIVATE_IP_NOT_ALLOWED",
		});
		expect(browser.quickAction).not.toHaveBeenCalled();
	});

	it.each([
		[429, "RATE_LIMITED"],
		[422, "PAGE_FETCH_FAILED"],
		[503, "BROWSER_UNAVAILABLE"],
	] as const)("maps provider status %s to %s", async (status, code) => {
		const service = createService(new Response(null, { status }));

		await expect(service.convert("https://example.com")).rejects.toMatchObject({
			code,
		});
	});

	it("maps binding failures to an unavailable error", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const service = createService(new Error("binding unavailable"));

		await expect(service.convert("https://example.com")).rejects.toEqual(
			new MarkdownError("BROWSER_UNAVAILABLE"),
		);
		consoleError.mockRestore();
	});

	it("stops before Browser Run when the client is rate limited", async () => {
		const browser = createBrowser(
			Response.json({ success: true, result: "unused" }),
		);
		const service = new MarkdownService({
			browser,
			rateLimiter: createRateLimiter(false),
			rateLimitKey: "test-client",
		});

		await expect(service.convert("https://example.com")).rejects.toMatchObject({
			code: "RATE_LIMITED",
		});
		expect(browser.quickAction).not.toHaveBeenCalled();
	});
});
