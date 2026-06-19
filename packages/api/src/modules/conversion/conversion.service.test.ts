import { describe, expect, it, vi } from "vitest";

import { ConversionError } from "./conversion.errors";
import { ConversionService } from "./conversion.service";

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
	new ConversionService({
		browser: createBrowser(response),
		rateLimiter,
		rateLimitKey: "test-client",
	});

describe("ConversionService", () => {
	it.each([
		[
			"markdown",
			"markdown",
			"# Example",
			["image", "media", "font", "stylesheet"],
			"domcontentloaded",
		],
		[
			"html",
			"content",
			"<!doctype html><html></html>",
			["image", "media", "font"],
			"networkidle2",
		],
	] as const)("converts %s and normalizes a public URL", async (format, action, result, rejectedResources, waitUntil) => {
		const browser = createBrowser(Response.json({ success: true, result }));
		const rateLimiter = createRateLimiter();
		const service = new ConversionService({
			browser,
			rateLimiter,
			rateLimitKey: "203.0.113.10",
		});

		await expect(
			service.convert(" HTTPS://Example.COM:443/page ", format),
		).resolves.toEqual({
			sourceUrl: "https://example.com/page",
			result,
		});
		expect(browser.quickAction).toHaveBeenCalledWith(
			action,
			expect.objectContaining({
				url: "https://example.com/page",
				rejectResourceTypes: rejectedResources,
				gotoOptions: {
					timeout: 30_000,
					waitUntil,
				},
				cacheTTL: 300,
			}),
		);
		expect(rateLimiter.limit).toHaveBeenCalledWith({
			key: "conversion:203.0.113.10",
		});
	});

	it("uses one rate-limit namespace key for both formats", async () => {
		const rateLimiter = createRateLimiter();
		const browser = {
			quickAction: vi.fn(async () =>
				Response.json({ success: true, result: "converted" }),
			),
		};
		const service = new ConversionService({
			browser,
			rateLimiter,
			rateLimitKey: "shared-client",
		});

		await service.convert("https://example.com", "markdown");
		await service.convert("https://example.com", "html");

		expect(rateLimiter.limit).toHaveBeenNthCalledWith(1, {
			key: "conversion:shared-client",
		});
		expect(rateLimiter.limit).toHaveBeenNthCalledWith(2, {
			key: "conversion:shared-client",
		});
	});

	it("does not call Browser Run for blocked URLs", async () => {
		const browser = createBrowser(
			Response.json({ success: true, result: "unused" }),
		);
		const service = new ConversionService({
			browser,
			rateLimiter: createRateLimiter(),
			rateLimitKey: "test-client",
		});

		await expect(
			service.convert("http://127.0.0.1", "html"),
		).rejects.toMatchObject({
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

		await expect(
			service.convert("https://example.com", "html"),
		).rejects.toMatchObject({ code });
	});

	it.each([
		Response.json({ success: false, result: "unused" }),
		Response.json({ success: true }),
		new Response("not json"),
	])("rejects malformed Browser Run payloads", async (response) => {
		const service = createService(response);

		await expect(
			service.convert("https://example.com", "html"),
		).rejects.toMatchObject({ code: "PAGE_FETCH_FAILED" });
	});

	it("maps binding failures to an unavailable error", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const service = createService(new Error("binding unavailable"));

		await expect(
			service.convert("https://example.com", "html"),
		).rejects.toEqual(new ConversionError("BROWSER_UNAVAILABLE"));
		consoleError.mockRestore();
	});

	it("stops before Browser Run when the client is rate limited", async () => {
		const browser = createBrowser(
			Response.json({ success: true, result: "unused" }),
		);
		const service = new ConversionService({
			browser,
			rateLimiter: createRateLimiter(false),
			rateLimitKey: "test-client",
		});

		await expect(
			service.convert("https://example.com", "html"),
		).rejects.toMatchObject({ code: "RATE_LIMITED" });
		expect(browser.quickAction).not.toHaveBeenCalled();
	});

	it.each([
		["markdown", 1_000_001, "MARKDOWN_TOO_LARGE"],
		["html", 2_000_001, "HTML_TOO_LARGE"],
	] as const)("rejects oversized %s output", async (format, length, code) => {
		const service = createService(
			Response.json({ success: true, result: "x".repeat(length) }),
		);

		await expect(
			service.convert("https://example.com", format),
		).rejects.toMatchObject({ code });
	});
});
