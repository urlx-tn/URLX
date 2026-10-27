import { describe, expect, it, vi } from "vitest";

import { ConversionError } from "./conversion.errors";
import { ConversionService } from "./conversion.service";

const createRenderer = (result: string | Error) => ({
	render: vi.fn(async () => {
		if (result instanceof Error) throw result;
		return result;
	}),
});

const createRateLimiter = (success = true) => ({
	limit: vi.fn(async () => ({ success })),
});

const createService = (
	result: string | Error,
	visitorRateLimiter = createRateLimiter(),
	ipRateLimiter = createRateLimiter(),
) =>
	new ConversionService({
		renderer: createRenderer(result),
		clientIp: "test-client",
		ipRateLimiter,
		rateLimitIdentity: { kind: "fallback-ip" },
		visitorRateLimiter,
	});

describe("ConversionService", () => {
	it.each([
		[
			"markdown",
			"# Example",
			["image", "media", "font", "stylesheet"],
			"domcontentloaded",
			1_000_000,
		],
		[
			"html",
			"<!doctype html><html></html>",
			["image", "media", "font"],
			"networkidle2",
			2_000_000,
		],
	] as const)(
		"converts %s and normalizes a public URL",
		async (format, result, rejectResourceTypes, waitUntil, maxLength) => {
			const renderer = createRenderer(result);
			const ipRateLimiter = createRateLimiter();
			const visitorRateLimiter = createRateLimiter();
			const service = new ConversionService({
				renderer,
				clientIp: "203.0.113.10",
				ipRateLimiter,
				rateLimitIdentity: {
					kind: "visitor",
					visitorId: "8d78d008-63e5-4e56-a9ed-82824bd87c10",
				},
				visitorRateLimiter,
			});

			await expect(
				service.convert(" HTTPS://Example.COM:443/page ", format),
			).resolves.toEqual({ sourceUrl: "https://example.com/page", result });
			expect(renderer.render).toHaveBeenCalledWith({
				url: "https://example.com/page",
				format,
				timeoutMs: 30_000,
				waitUntil,
				rejectResourceTypes,
				maxLength,
			});
			expect(ipRateLimiter.limit).toHaveBeenCalledWith({
				key: "conversion:ip:203.0.113.10",
			});
			expect(visitorRateLimiter.limit).toHaveBeenCalledWith({
				key: "conversion:visitor:8d78d008-63e5-4e56-a9ed-82824bd87c10",
			});
		},
	);

	it("shares the rate-limit namespace across output formats", async () => {
		const ipRateLimiter = createRateLimiter();
		const visitorRateLimiter = createRateLimiter();
		const service = new ConversionService({
			renderer: createRenderer("converted"),
			clientIp: "shared-client",
			ipRateLimiter,
			rateLimitIdentity: { kind: "fallback-ip" },
			visitorRateLimiter,
		});

		await service.convert("https://example.com", "markdown");
		await service.convert("https://example.com", "html");

		expect(visitorRateLimiter.limit).toHaveBeenNthCalledWith(1, {
			key: "conversion:fallback-ip:shared-client",
		});
		expect(visitorRateLimiter.limit).toHaveBeenNthCalledWith(2, {
			key: "conversion:fallback-ip:shared-client",
		});
		expect(ipRateLimiter.limit).toHaveBeenCalledTimes(2);
	});

	it("does not call the renderer for blocked URLs", async () => {
		const renderer = createRenderer("unused");
		const ipRateLimiter = createRateLimiter();
		const visitorRateLimiter = createRateLimiter();
		const service = new ConversionService({
			renderer,
			clientIp: "test-client",
			ipRateLimiter,
			rateLimitIdentity: { kind: "fallback-ip" },
			visitorRateLimiter,
		});

		await expect(
			service.convert("http://127.0.0.1", "html"),
		).rejects.toMatchObject({
			code: "PRIVATE_IP_NOT_ALLOWED",
		});
		expect(renderer.render).not.toHaveBeenCalled();
		expect(ipRateLimiter.limit).not.toHaveBeenCalled();
		expect(visitorRateLimiter.limit).not.toHaveBeenCalled();
	});

	it("maps renderer failures to an unavailable error", async () => {
		const service = createService(new Error("renderer unavailable"));
		await expect(
			service.convert("https://example.com", "html"),
		).rejects.toEqual(new ConversionError("BROWSER_UNAVAILABLE"));
	});

	it("stops before rendering when a rate limit is exceeded", async () => {
		const renderer = createRenderer("unused");
		const visitorRateLimiter = createRateLimiter(false);
		const service = new ConversionService({
			renderer,
			clientIp: "test-client",
			ipRateLimiter: createRateLimiter(),
			rateLimitIdentity: { kind: "fallback-ip" },
			visitorRateLimiter,
		});

		await expect(
			service.convert("https://example.com", "html"),
		).rejects.toMatchObject({
			code: "RATE_LIMITED",
		});
		expect(renderer.render).not.toHaveBeenCalled();
	});

	it.each([
		["markdown", 1_000_001, "MARKDOWN_TOO_LARGE"],
		["html", 2_000_001, "HTML_TOO_LARGE"],
	] as const)("rejects oversized %s output", async (format, length, code) => {
		const service = createService("x".repeat(length));
		await expect(
			service.convert("https://example.com", format),
		).rejects.toMatchObject({
			code,
		});
	});
});
