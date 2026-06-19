import {
	MarkdownError,
	toMarkdownError,
} from "@urlx/api/modules/markdown/markdown.errors";
import { convertMarkdownInputSchema } from "@urlx/api/modules/markdown/markdown.schema";
import { MarkdownService } from "@urlx/api/modules/markdown/markdown.service";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

type MarkdownBindings = {
	BROWSER: BrowserRun;
	CORS_ORIGIN: string;
	MARKDOWN_RATE_LIMIT: RateLimit;
};

type MarkdownEnv = {
	Bindings: MarkdownBindings;
};

type ErrorStatus = 400 | 413 | 422 | 429 | 500 | 503;

const app = new Hono<MarkdownEnv>();

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
		const input = convertMarkdownInputSchema.safeParse(await c.req.json());
		if (!input.success) {
			throw new MarkdownError("INVALID_URL");
		}

		const service = new MarkdownService({
			browser: c.env.BROWSER,
			rateLimiter: c.env.MARKDOWN_RATE_LIMIT,
			rateLimitKey: getClientIp(c.req.header()),
		});
		return c.json(await service.convert(input.data.url));
	} catch (error) {
		const markdownError = toMarkdownError(error);
		return c.json(
			{
				code: markdownError.code,
				message: markdownError.message,
			},
			markdownError.status as ErrorStatus,
		);
	}
});

app.get("/", (c) => c.text("OK"));

function getClientIp(headers: Record<string, string>) {
	return (
		headers["cf-connecting-ip"] ??
		headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
		"unknown"
	);
}

export default app;
