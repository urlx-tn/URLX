import { Hono } from "hono";

import {
	type PlaywrightRenderer,
	RendererError,
	type RenderInput,
} from "./render";

const maxRequestBodyBytes = 4_096;

export function createRendererApp(
	renderer: Pick<PlaywrightRenderer, "render">,
) {
	const app = new Hono();
	app.get("/healthz", (c) =>
		c.text("OK", 200, { "Cache-Control": "no-store" }),
	);
	app.post("/render", async (c) => {
		const body = await readJsonBody(c.req.raw, maxRequestBodyBytes);
		if (!isRenderInput(body))
			return c.json({ code: "INVALID_RENDER_REQUEST" }, 400, {
				"Cache-Control": "no-store",
			});
		try {
			const result = await renderer.render(body);
			return c.json({ success: true, result }, 200, {
				"Cache-Control": "no-store",
			});
		} catch (error) {
			if (error instanceof RendererError) {
				const status =
					error.code === "INVALID_URL"
						? 400
						: error.code.endsWith("_TOO_LARGE")
							? 413
							: 502;
				return c.json({ code: error.code }, status, {
					"Cache-Control": "no-store",
				});
			}
			return c.json({ code: "RENDERER_BUSY" }, 503, {
				"Cache-Control": "no-store",
			});
		}
	});
	return app;
}

function isRenderInput(value: unknown): value is RenderInput {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RenderInput>;
	return (
		typeof candidate.url === "string" &&
		candidate.url.length <= 2_048 &&
		(candidate.format === "html" || candidate.format === "markdown") &&
		Object.keys(value).every((key) => key === "url" || key === "format")
	);
}

async function readJsonBody(
	request: Request,
	maxBytes: number,
): Promise<unknown> {
	const contentLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				return null;
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
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}
