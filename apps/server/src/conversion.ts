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
	CONVERSION_RATE_LIMIT: RateLimit;
	CORS_ORIGIN: string;
};

type ConversionEnv = {
	Bindings: ConversionBindings;
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
		allowHeaders: ["Content-Type"],
	}),
);
app.use("/*", async (c, next) => {
	await next();
	c.res.headers.set("Cache-Control", "no-store");
	c.res.headers.set("X-Content-Type-Options", "nosniff");
	c.res.headers.set("Referrer-Policy", "no-referrer");
});

app.post("/markdown", async (c) => {
	try {
		const input = convertUrlInputSchema.safeParse(await c.req.json());
		if (!input.success) {
			throw new ConversionError("INVALID_URL");
		}

		const service = new ConversionService({
			browser: c.env.BROWSER,
			rateLimiter: c.env.CONVERSION_RATE_LIMIT,
			rateLimitKey: getClientIp(c.req.header()),
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
			rateLimiter: c.env.CONVERSION_RATE_LIMIT,
			rateLimitKey: getClientIp(c.req.header()),
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
