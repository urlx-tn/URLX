import { beforeAll, describe, expect, it, vi } from "vitest";
import { conversionApp } from "../src/conversion";
import {
	createConversionRendererClient,
	createUnavailableConversionRenderer,
} from "../src/lib/conversion-renderer-client";
import type { ConversionAppBindings } from "../src/runtime/bindings";

const allowLimit = { limit: async () => ({ success: true }) };
const maxBodyBytes = 16 * 1024;
let visitorKey!: CryptoKey;

beforeAll(async () => {
	visitorKey = await crypto.subtle.importKey(
		"raw",
		new Uint8Array(32).fill(9),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
});

function bindings(render: ReturnType<typeof vi.fn>): ConversionAppBindings {
	return {
		BROWSER_RENDERER: { render } as never,
		CONVERSION_IP_RATE_LIMIT: allowLimit,
		CONVERSION_VISITOR_RATE_LIMIT: allowLimit,
		CORS_ORIGIN: "https://urlx.example",
		VISITOR_TOKEN_KEY: visitorKey,
	};
}

function chunkedRequest(url: string, json: string) {
	const bytes = new TextEncoder().encode(json);
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			const end = Math.min(offset + 4_096, bytes.length);
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		},
	});
	return new Request(`http://localhost${url}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		duplex: "half",
	} as RequestInit);
}

describe("conversion routes", () => {
	it.each(["/html", "/markdown"])(
		"caps streamed request bodies including unknown properties on %s",
		async (path) => {
			const render = vi.fn(async () => "should not run");
			const extraPayload = JSON.stringify({
				url: "https://example.com/",
				unexpected: "x".repeat(maxBodyBytes),
			});
			const response = await conversionApp.fetch(
				chunkedRequest(path, extraPayload),
				bindings(render),
			);

			expect(response.status).toBe(413);
			expect(await response.json()).toMatchObject({
				code: "PAYLOAD_TOO_LARGE",
			});
			expect(render).not.toHaveBeenCalled();
		},
	);

	it.each(["/html", "/markdown"])(
		"enforces the shared URL length limit on %s",
		async (path) => {
			const render = vi.fn(async () => "should not run");
			const response = await conversionApp.request(
				path,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						url: `https://example.com/${"x".repeat(2_050)}`,
					}),
				},
				bindings(render),
			);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "URL_TOO_LONG" });
			expect(render).not.toHaveBeenCalled();
		},
	);

	it("maps renderer queue saturation to the stable unavailable response without reading the error body", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("renderer busy".repeat(100_000), { status: 503 }),
		);
		const render = createConversionRendererClient({
			baseUrl: "http://conversion-renderer:3100",
			keyMaterial: "stable-test-key-material-with-at-least-32-bytes",
			fetcher: fetcher as typeof fetch,
		});
		const response = await conversionApp.request(
			"/html",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: "https://example.com/" }),
			},
			bindings(render.render as never),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "BROWSER_UNAVAILABLE",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("maps an unavailable renderer connection to 503", async () => {
		const render = createConversionRendererClient({
			baseUrl: "http://conversion-renderer:3100",
			keyMaterial: "stable-test-key-material-with-at-least-32-bytes",
			fetcher: vi.fn(async () => {
				throw new Error("private transport detail");
			}) as typeof fetch,
		});
		const response = await conversionApp.request(
			"/markdown",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: "https://example.com/" }),
			},
			bindings(render.render as never),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "BROWSER_UNAVAILABLE",
		});
	});

	it("returns the stable unavailable response when browser conversion is disabled", async () => {
		const response = await conversionApp.request(
			"/html",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: "https://example.com/" }),
			},
			bindings(createUnavailableConversionRenderer().render as never),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "BROWSER_UNAVAILABLE",
			message: "The conversion service is temporarily unavailable.",
		});
	});
});
