import { describe, expect, it, vi } from "vitest";

import { MetadataError } from "./metadata.errors";
import { MetadataService } from "./metadata.service";

const fixedDate = new Date("2026-06-22T12:00:00.000Z");

const createRateLimiter = (success = true) => ({
	limit: vi.fn(async () => ({ success })),
});

const createService = (
	fetcher: typeof fetch,
	rateLimiter = createRateLimiter(),
) =>
	new MetadataService({
		fetcher,
		rateLimiter,
		rateLimitKey: "203.0.113.10",
		now: () => fixedDate,
	});

function htmlResponse(html: string, init: ResponseInit = {}) {
	return new Response(html, {
		...init,
		headers: {
			"content-type": "text/html; charset=utf-8",
			...init.headers,
		},
	});
}

describe("MetadataService", () => {
	it("extracts metadata and builds a deterministic preview", async () => {
		const fetcher = vi.fn(async () =>
			htmlResponse(`<!doctype html>
				<html lang="en">
					<head>
						<meta charset="utf-8">
						<title>Fallback title</title>
						<meta name="description" content="Fallback description">
						<link rel="canonical" href="/canonical">
						<link rel="icon" href="/favicon.ico">
						<meta name="viewport" content="width=device-width, initial-scale=1">
						<meta name="robots" content="index,follow">
						<meta name="theme-color" content="#ffffff">
						<meta property="og:title" content="OG title">
						<meta property="og:description" content="OG description">
						<meta property="og:url" content="https://example.com/canonical">
						<meta property="og:type" content="article">
						<meta property="og:site_name" content="Example Site">
						<meta property="og:locale" content="en_US">
						<meta property="og:image" content="/image.png">
						<meta property="og:image:secure_url" content="https://cdn.example.com/image.png">
						<meta property="og:image:type" content="image/png">
						<meta property="og:image:width" content="1200">
						<meta property="og:image:height" content="630">
						<meta property="og:image:alt" content="Image alt">
						<meta name="twitter:card" content="summary_large_image">
						<meta name="twitter:title" content="Twitter title">
						<meta name="twitter:description" content="Twitter description">
						<meta name="twitter:image" content="/twitter.png">
						<meta name="twitter:image:alt" content="Twitter alt">
						<meta name="twitter:site" content="@example">
						<meta name="twitter:creator" content="@author">
					</head>
					<body><script>throw new Error("unused")</script></body>
				</html>`),
		);
		const service = createService(fetcher);

		const result = await service.inspect(" HTTPS://Example.COM:443/page ");

		expect(result).toMatchObject({
			sourceUrl: "https://example.com/page",
			finalUrl: "https://example.com/page",
			status: 200,
			ok: true,
			checkedAt: fixedDate.toISOString(),
			title: "Fallback title",
			description: "Fallback description",
			canonicalUrl: "https://example.com/canonical",
			language: "en",
			charset: "utf-8",
			viewport: "width=device-width, initial-scale=1",
			robots: "index,follow",
			themeColor: "#ffffff",
			faviconUrl: "https://example.com/favicon.ico",
			openGraph: {
				title: "OG title",
				description: "OG description",
				url: "https://example.com/canonical",
				type: "article",
				siteName: "Example Site",
				locale: "en_US",
				images: [
					{
						url: "https://example.com/image.png",
						secureUrl: "https://cdn.example.com/image.png",
						type: "image/png",
						width: 1200,
						height: 630,
						alt: "Image alt",
					},
				],
			},
			twitter: {
				card: "summary_large_image",
				site: "@example",
				creator: "@author",
				title: "Twitter title",
				description: "Twitter description",
				image: "https://example.com/twitter.png",
				imageAlt: "Twitter alt",
			},
			preview: {
				title: "OG title",
				description: "OG description",
				imageUrl: "https://example.com/image.png",
				imageAlt: "Image alt",
				siteName: "Example Site",
				url: "https://example.com/canonical",
				faviconUrl: "https://example.com/favicon.ico",
			},
		});
		expect(result.rawTags.length).toBeGreaterThan(10);
		expect(fetcher).toHaveBeenCalledWith(
			"https://example.com/page",
			expect.objectContaining({
				method: "GET",
				redirect: "manual",
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"User-Agent": "URLX Metadata Inspector (+https://www.urlx.tn)",
				},
			}),
		);
	});

	it("rejects blocked URLs before rate limiting or fetch", async () => {
		const fetcher = vi.fn(async () => htmlResponse(""));
		const rateLimiter = createRateLimiter();
		const service = createService(fetcher, rateLimiter);

		await expect(service.inspect("http://127.0.0.1")).rejects.toMatchObject({
			code: "PRIVATE_IP_NOT_ALLOWED",
		});
		expect(rateLimiter.limit).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("stops before fetch when rate limited", async () => {
		const fetcher = vi.fn(async () => htmlResponse(""));
		const service = createService(fetcher, createRateLimiter(false));

		await expect(service.inspect("https://example.com")).rejects.toMatchObject({
			code: "RATE_LIMITED",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("follows redirects and resolves relative locations", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location: "/next" } }),
			)
			.mockResolvedValueOnce(htmlResponse("<title>Done</title>"));
		const service = createService(fetcher);

		const result = await service.inspect("https://example.com/start");

		expect(result.finalUrl).toBe("https://example.com/next");
		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://example.com/next",
				status: 302,
			},
		]);
		expect(fetcher).toHaveBeenNthCalledWith(
			2,
			"https://example.com/next",
			expect.any(Object),
		);
	});

	it("rejects redirect loops and redirect chains over the limit", async () => {
		const loopFetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location: "/b" } }),
			)
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location: "/a" } }),
			);
		const loopService = createService(loopFetcher);

		await expect(
			loopService.inspect("https://example.com/a"),
		).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });

		const chainFetcher = vi.fn(async () => {
			const callCount = chainFetcher.mock.calls.length;
			return new Response(null, {
				status: 302,
				headers: { location: `/redirect-${callCount}` },
			});
		});
		const chainService = createService(chainFetcher);

		await expect(
			chainService.inspect("https://example.com/start"),
		).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
	});

	it("maps timeout and network failures", async () => {
		const timeoutService = createService(
			vi.fn(async () => {
				throw new DOMException("Aborted", "AbortError");
			}),
		);
		await expect(timeoutService.inspect("https://example.com")).rejects.toEqual(
			new MetadataError("FETCH_TIMEOUT"),
		);

		const failedService = createService(
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		await expect(failedService.inspect("https://example.com")).rejects.toEqual(
			new MetadataError("FETCH_FAILED"),
		);
	});

	it("returns diagnostics for non-HTML responses", async () => {
		const service = createService(
			vi.fn(
				async () =>
					new Response("{}", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		const result = await service.inspect("https://example.com/data.json");

		expect(result.rawTags).toEqual([]);
		expect(result.warnings).toEqual([
			{
				code: "NON_HTML_CONTENT_TYPE",
				severity: "warning",
				message:
					"The response is not HTML, so metadata could not be extracted.",
			},
		]);
	});

	it("caps HTML reads and raw metadata output", async () => {
		const rawTags = Array.from(
			{ length: 120 },
			(_, index) => `<meta name="x-${index}" content="${"x".repeat(800)}">`,
		).join("");
		const service = createService(
			vi.fn(async () =>
				htmlResponse(`<html><head>${rawTags}${"x".repeat(1_050_000)}`),
			),
		);

		const result = await service.inspect("https://example.com");

		expect(result.rawTags).toHaveLength(100);
		expect(result.rawTags[0]?.value).toHaveLength(500);
		expect(result.warnings.map((warning) => warning.code)).toContain(
			"HTML_TRUNCATED",
		);
	});

	it("ignores invalid metadata URLs and preserves fallback preview precedence", async () => {
		const service = createService(
			vi.fn(async () =>
				htmlResponse(`
					<html>
						<head>
							<title>Title</title>
							<meta name="description" content="Description">
							<meta property="og:image" content="data:text/plain,hi">
							<meta name="twitter:image" content="/twitter.png">
						</head>
					</html>`),
			),
		);

		const result = await service.inspect("https://example.com/article");

		expect(result.preview).toMatchObject({
			title: "Title",
			description: "Description",
			imageUrl: "https://example.com/twitter.png",
			url: "https://example.com/article",
		});
		expect(result.warnings.map((warning) => warning.code)).toContain(
			"INVALID_METADATA_URL",
		);
		expect(result.warnings.map((warning) => warning.code)).toContain(
			"MISSING_CANONICAL_URL",
		);
	});
});
