import { createHmac } from "node:crypto";
import { ConversionError } from "@urlx/api/modules/conversion/conversion.errors";
import type {
	ConversionRenderer,
	ConversionRenderOptions,
} from "@urlx/api/modules/conversion/conversion.service";

type RendererCache = {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
};

type ProxyFetchInit = RequestInit & { proxy?: string | false };

export function createConversionRendererClient(options: {
	baseUrl: string;
	keyMaterial: string;
	cache?: RendererCache;
	fetcher?: typeof fetch;
}): ConversionRenderer {
	const base = new URL(options.baseUrl);
	if (options.keyMaterial.length < 32)
		throw new Error("Conversion cache key material is too short");
	if (
		base.protocol !== "http:" ||
		base.hostname !== "conversion-renderer" ||
		base.port !== "3100" ||
		base.pathname !== "/" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	) {
		throw new Error(
			"BROWSER_RENDERER_URL must target http://conversion-renderer:3100",
		);
	}
	const fetcher = options.fetcher ?? globalThis.fetch;
	return {
		async render(renderOptions: ConversionRenderOptions) {
			const cacheKey = `urlx:conversion:v1:${createHmac(
				"sha256",
				options.keyMaterial,
			)
				.update(renderOptions.format)
				.update("\0")
				.update(renderOptions.url)
				.digest("hex")}`;
			if (options.cache) {
				try {
					const cached = await options.cache.get(cacheKey);
					if (cached && cached.length <= renderOptions.maxLength) return cached;
				} catch {
					// Cache outages do not disable conversion; rate limiting remains fail-closed.
				}
			}

			const response = await fetcher(new URL("/render", base), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url: renderOptions.url,
					format: renderOptions.format,
				}),
				signal: AbortSignal.timeout(renderOptions.timeoutMs + 5_000),
				proxy: false,
			} as ProxyFetchInit);
			if (response.status === 503) {
				await response.body?.cancel().catch(() => undefined);
				throw new ConversionError("BROWSER_UNAVAILABLE");
			}
			if (!response.ok) {
				if (response.status === 413) {
					const payload = await readBoundedJson(response, 1_024);
					if (
						payload.code === "HTML_TOO_LARGE" ||
						payload.code === "MARKDOWN_TOO_LARGE"
					)
						throw new ConversionError(payload.code);
				} else {
					await response.body?.cancel().catch(() => undefined);
				}
				throw new Error("Conversion renderer request failed");
			}
			const payload = await readBoundedJson(
				response,
				renderOptions.maxLength * 6 + 1_024,
			);
			if (payload.success !== true || typeof payload.result !== "string")
				throw new Error("Conversion renderer returned an invalid response");
			if (payload.result.length > renderOptions.maxLength)
				throw new ConversionError(
					renderOptions.format === "html"
						? "HTML_TOO_LARGE"
						: "MARKDOWN_TOO_LARGE",
				);
			if (options.cache && payload.result.length <= 256 * 1024) {
				try {
					await options.cache.set(cacheKey, payload.result, 300);
				} catch {
					// A cache write is opportunistic.
				}
			}
			return payload.result;
		},
	};
}

export function createUnavailableConversionRenderer(): ConversionRenderer {
	return {
		async render() {
			throw new ConversionError("BROWSER_UNAVAILABLE");
		},
	};
}

async function readBoundedJson(response: Response, maximumBytes: number) {
	const headerLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(headerLength) && headerLength > maximumBytes)
		throw new Error("Conversion renderer response exceeded its size limit");
	if (!response.body)
		throw new Error("Conversion renderer returned an empty response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maximumBytes) {
				await reader.cancel();
				throw new Error("Conversion renderer response exceeded its size limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
	return parsed && typeof parsed === "object"
		? (parsed as { success?: unknown; result?: unknown; code?: unknown })
		: {};
}
