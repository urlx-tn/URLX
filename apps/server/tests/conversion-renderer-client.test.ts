import { createHmac } from "node:crypto";
import { ConversionError } from "@urlx/api/modules/conversion/conversion.errors";
import type { ConversionRenderOptions } from "@urlx/api/modules/conversion/conversion.service";
import { describe, expect, it, vi } from "vitest";
import { createConversionRendererClient } from "../src/lib/conversion-renderer-client";

const keyMaterial = "test-key-material-value-at-least-thirty-two-bytes";
const options: ConversionRenderOptions = {
	url: "https://example.com/page?token=private-value",
	format: "html" as const,
	timeoutMs: 30_000,
	waitUntil: "networkidle2" as const,
	rejectResourceTypes: ["font", "image", "media"],
	maxLength: 2_000_000,
};

describe("conversion renderer client", () => {
	it("uses a private internal service URL and HMAC cache key with a 5 minute TTL", async () => {
		const entries = new Map<string, string>();
		const cache = {
			get: vi.fn(async (key: string) => entries.get(key) ?? null),
			set: vi.fn(
				async (
					key: string,
					value: string,
					..._args: Array<string | number>
				) => {
					entries.set(key, value);
					return "OK" as const;
				},
			),
		};
		const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			expect(init?.method).toBe("POST");
			expect((init as RequestInit & { proxy?: string | false }).proxy).toBe(
				false,
			);
			return new Response(
				JSON.stringify({ success: true, result: "<h1>Safe</h1>" }),
			);
		});
		const client = createConversionRendererClient({
			baseUrl: "http://conversion-renderer:3100",
			keyMaterial,
			cache,
			fetcher: fetcher as typeof fetch,
		});
		expect(await client.render(options)).toBe("<h1>Safe</h1>");
		expect(await client.render(options)).toBe("<h1>Safe</h1>");
		expect(fetcher).toHaveBeenCalledTimes(1);
		const cacheKey = cache.get.mock.calls[0]?.[0] ?? "";
		expect(cacheKey).toBe(
			`urlx:conversion:v1:${createHmac("sha256", keyMaterial).update("html").update("\0").update(options.url).digest("hex")}`,
		);
		expect(cacheKey).not.toContain("private-value");
		expect(cache.set.mock.calls[0]?.[2]).toBe(300);
	});

	it("bounds response data and preserves a rendered-size error", async () => {
		const client = createConversionRendererClient({
			baseUrl: "http://conversion-renderer:3100",
			keyMaterial,
			fetcher: async () =>
				new Response(JSON.stringify({ code: "HTML_TOO_LARGE" }), {
					status: 413,
				}),
		});
		await expect(client.render(options)).rejects.toBeInstanceOf(
			ConversionError,
		);
		const tooLargeResponse = new Response(
			JSON.stringify({ success: true, result: "x".repeat(2_000) }),
		);
		const bounded = createConversionRendererClient({
			baseUrl: "http://conversion-renderer:3100",
			keyMaterial,
			fetcher: async () => tooLargeResponse,
		});
		await expect(
			bounded.render({ ...options, maxLength: 100 }),
		).rejects.toThrow(/size limit/);
		const escapedHtml = "\0".repeat(2_000);
		const unicodeSafe = createConversionRendererClient({
			baseUrl: "http://conversion-renderer:3100",
			keyMaterial,
			fetcher: async () =>
				new Response(JSON.stringify({ success: true, result: escapedHtml })),
		});
		await expect(
			unicodeSafe.render({ ...options, maxLength: escapedHtml.length }),
		).resolves.toBe(escapedHtml);
	});

	it("rejects renderer URL and missing HMAC material at construction", () => {
		expect(() =>
			createConversionRendererClient({
				baseUrl: "http://127.0.0.1:3100",
				keyMaterial,
			}),
		).toThrow(/conversion-renderer/);
		expect(() =>
			createConversionRendererClient({
				baseUrl: "http://conversion-renderer:3100",
				keyMaterial: "short",
			}),
		).toThrow(/key material/);
	});
});
