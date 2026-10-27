import {
	type AnonymousVisitorVerification,
	verifyAnonymousVisitorToken,
} from "@urlx/api/lib/anonymous-visitor";
import { getTrustedClientIp } from "@urlx/api/lib/client-ip";
import type { RateLimitIdentity } from "@urlx/api/lib/layered-rate-limit";
import { maxUrlLength } from "@urlx/api/lib/validate-url";
import {
	ConversionError,
	toConversionError,
} from "@urlx/api/modules/conversion/conversion.errors";
import { convertUrlInputSchema } from "@urlx/api/modules/conversion/conversion.schema";
import { ConversionService } from "@urlx/api/modules/conversion/conversion.service";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { ConversionAppBindings } from "./runtime/bindings";

type ConversionEnv = {
	Bindings: ConversionAppBindings;
	Variables: {
		rateLimitIdentity: RateLimitIdentity;
		visitorTokenVerification: AnonymousVisitorVerification;
	};
};

type ErrorStatus = 400 | 413 | 422 | 429 | 500 | 503;

const app = new Hono<ConversionEnv>();
export const conversionApp = app;
const maxConversionRequestBytes = 16 * 1024;

app.use(logger());
app.use(
	"/*",
	cors({
		origin: (origin, c) => {
			if (!origin) {
				return c.env.CORS_ORIGIN;
			}

			return origin === c.env.CORS_ORIGIN ? origin : "";
		},
		allowMethods: ["POST", "OPTIONS"],
		allowHeaders: ["Content-Type", "X-URLX-Visitor-Token"],
		exposeHeaders: ["Retry-After", "X-URLX-Visitor-Token-Refresh"],
	}),
);
app.use("/*", async (c, next) => {
	const verification = await verifyAnonymousVisitorToken(
		c.req.header("X-URLX-Visitor-Token"),
		c.env.VISITOR_TOKEN_KEY,
	);
	c.set("visitorTokenVerification", verification);
	c.set(
		"rateLimitIdentity",
		verification.status === "valid"
			? { kind: "visitor", visitorId: verification.visitorId }
			: { kind: "fallback-ip" },
	);
	await next();
	c.res.headers.set("Cache-Control", "no-store");
	c.res.headers.set("X-Content-Type-Options", "nosniff");
	c.res.headers.set("Referrer-Policy", "no-referrer");
	if (verification.status === "invalid") {
		c.res.headers.set("X-URLX-Visitor-Token-Refresh", "required");
	}
});

app.post("/markdown", async (c) => {
	try {
		return await handleConversion(c, "markdown");
	} catch (error) {
		return conversionErrorResponse(c, error);
	}
});

app.post("/html", async (c) => {
	try {
		return await handleConversion(c, "html");
	} catch (error) {
		return conversionErrorResponse(c, error);
	}
});

async function handleConversion(
	c: Context<ConversionEnv>,
	format: "html" | "markdown",
) {
	const body = await readBoundedJson(c.req.raw);
	if (!body.ok) {
		if (body.error === "PAYLOAD_TOO_LARGE") {
			return c.json(
				{ code: body.error, message: "Request body exceeds 16 KiB." },
				413,
			);
		}
		throw new ConversionError("INVALID_URL");
	}
	const input = convertUrlInputSchema.safeParse(body.value);
	if (!input.success) throw new ConversionError("INVALID_URL");
	if (input.data.url.trim().length > maxUrlLength)
		throw new ConversionError("URL_TOO_LONG");

	const service = new ConversionService({
		renderer: c.env.BROWSER_RENDERER,
		clientIp: getTrustedClientIp(c.req.header()),
		ipRateLimiter: c.env.CONVERSION_IP_RATE_LIMIT,
		rateLimitIdentity: c.get("rateLimitIdentity"),
		visitorRateLimiter: c.env.CONVERSION_VISITOR_RATE_LIMIT,
	});
	const converted = await service.convert(input.data.url, format);
	return format === "markdown"
		? c.json({ sourceUrl: converted.sourceUrl, markdown: converted.result })
		: c.json({ sourceUrl: converted.sourceUrl, html: converted.result });
}

async function readBoundedJson(
	request: Request,
): Promise<
	| { ok: true; value: unknown }
	| { ok: false; error: "PAYLOAD_TOO_LARGE" | "INVALID_JSON" }
> {
	const contentLength = Number(request.headers.get("content-length"));
	if (
		Number.isFinite(contentLength) &&
		contentLength > maxConversionRequestBytes
	)
		return { ok: false, error: "PAYLOAD_TOO_LARGE" };
	const body = request.body;
	if (!body) return { ok: false, error: "INVALID_JSON" };
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxConversionRequestBytes) {
				await reader.cancel().catch(() => undefined);
				return { ok: false, error: "PAYLOAD_TOO_LARGE" };
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
		return {
			ok: true,
			value: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
		};
	} catch {
		return { ok: false, error: "INVALID_JSON" };
	}
}

function conversionErrorResponse(c: Context<ConversionEnv>, error: unknown) {
	const conversionError = toConversionError(error);
	if (conversionError.code === "RATE_LIMITED") {
		c.header("Retry-After", "60");
	}
	return c.json(
		{
			code: conversionError.code,
			message: conversionError.message,
		},
		conversionError.status as ErrorStatus,
	);
}

app.get("/", (c) => c.text("OK"));
app.get("/healthz", (c) => c.text("OK", 200, { "Cache-Control": "no-store" }));

export default app;
