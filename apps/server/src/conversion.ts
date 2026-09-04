import {
	type AnonymousVisitorVerification,
	verifyAnonymousVisitorToken,
} from "@urlx/api/lib/anonymous-visitor";
import type { RateLimitIdentity } from "@urlx/api/lib/layered-rate-limit";
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

type ConversionBindings = {
	BROWSER: BrowserRun;
	CONVERSION_IP_RATE_LIMIT: RateLimit;
	CONVERSION_VISITOR_RATE_LIMIT: RateLimit;
	CORS_ORIGIN: string;
	VISITOR_TOKEN_KEY: CryptoKey;
};

type ConversionEnv = {
	Bindings: ConversionBindings;
	Variables: {
		rateLimitIdentity: RateLimitIdentity;
		visitorTokenVerification: AnonymousVisitorVerification;
	};
};

type ErrorStatus = 400 | 413 | 422 | 429 | 500 | 503;

const app = new Hono<ConversionEnv>();

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
		const input = convertUrlInputSchema.safeParse(await c.req.json());
		if (!input.success) {
			throw new ConversionError("INVALID_URL");
		}

		const service = new ConversionService({
			browser: c.env.BROWSER,
			clientIp: getClientIp(c.req.header()),
			ipRateLimiter: c.env.CONVERSION_IP_RATE_LIMIT,
			rateLimitIdentity: c.get("rateLimitIdentity"),
			visitorRateLimiter: c.env.CONVERSION_VISITOR_RATE_LIMIT,
		});
		const converted = await service.convert(input.data.url, "markdown");
		return c.json({
			sourceUrl: converted.sourceUrl,
			markdown: converted.result,
		});
	} catch (error) {
		return conversionErrorResponse(c, error);
	}
});

app.post("/html", async (c) => {
	try {
		const input = convertUrlInputSchema.safeParse(await c.req.json());
		if (!input.success) {
			throw new ConversionError("INVALID_URL");
		}

		const service = new ConversionService({
			browser: c.env.BROWSER,
			clientIp: getClientIp(c.req.header()),
			ipRateLimiter: c.env.CONVERSION_IP_RATE_LIMIT,
			rateLimitIdentity: c.get("rateLimitIdentity"),
			visitorRateLimiter: c.env.CONVERSION_VISITOR_RATE_LIMIT,
		});
		const converted = await service.convert(input.data.url, "html");
		return c.json({
			sourceUrl: converted.sourceUrl,
			html: converted.result,
		});
	} catch (error) {
		return conversionErrorResponse(c, error);
	}
});

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

function getClientIp(headers: Record<string, string>) {
	return (
		headers["cf-connecting-ip"] ??
		headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
		"unknown"
	);
}

export default app;
