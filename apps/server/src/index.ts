import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createContext } from "@urlx/api/context";
import type { AnonymousVisitorVerification } from "@urlx/api/lib/anonymous-visitor";
import { issueAnonymousVisitorToken } from "@urlx/api/lib/anonymous-visitor";
import { appRouter } from "@urlx/api/routers/index";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { formsApp } from "./forms";
import { formsOgApp } from "./forms-og";
import { securityHeaders } from "./lib/security-headers";
import type { ApiAppBindings } from "./runtime/bindings";

type ServerHonoEnv = {
	Bindings: ApiAppBindings;
};

const app = new Hono<ServerHonoEnv>();
export const apiApp = app;

app.use("/*", async (c, next) => {
	c.header("X-Request-ID", crypto.randomUUID());
	await next();
});
app.use("/*", async (c, next) => {
	const startedAt = Date.now();
	await next();
	console.info(
		`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - startedAt}ms`,
	);
});
app.use(securityHeaders);
app.use(
	"/*",
	cors({
		origin: (origin, c) => {
			if (!origin) {
				return c.env.CORS_ORIGIN;
			}

			return origin === c.env.CORS_ORIGIN ? origin : "";
		},
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type", "X-URLX-Visitor-Token"],
		exposeHeaders: ["Retry-After", "X-URLX-Visitor-Token-Refresh"],
		credentials: true,
	}),
);

export const apiHandler = new OpenAPIHandler(appRouter, {
	plugins: [
		new OpenAPIReferencePlugin({
			schemaConverters: [new ZodToJsonSchemaConverter()],
		}),
	],
	interceptors: [
		onError((error) => {
			console.error("OpenAPI handler failed", {
				errorType: safeErrorType(error),
			});
		}),
	],
});

app.route("/", formsOgApp);
app.route("/", formsApp);

export const rpcHandler = new RPCHandler(appRouter, {
	interceptors: [
		onError((error) => {
			console.error("RPC handler failed", { errorType: safeErrorType(error) });
		}),
	],
});

app.use("/*", async (c, next) => {
	const context = await createContext({
		context: c,
		db: c.env.DB,
		fetcher: c.env.METADATA_FETCHER,
		metadataIpRateLimiter: c.env.METADATA_IP_RATE_LIMIT,
		metadataVisitorRateLimiter: c.env.METADATA_VISITOR_RATE_LIMIT,
		shortUrlBase: c.env.SHORT_URL_BASE,
	});

	const rpcResult = await rpcHandler.handle(c.req.raw, {
		prefix: "/rpc",
		context: context,
	});

	if (rpcResult.matched) {
		return decorateProtectedResponse(
			c.newResponse(rpcResult.response.body, rpcResult.response),
			context.visitorTokenVerification,
		);
	}

	const apiResult = await apiHandler.handle(c.req.raw, {
		prefix: "/api-reference",
		context: context,
	});

	if (apiResult.matched) {
		return decorateProtectedResponse(
			c.newResponse(apiResult.response.body, apiResult.response),
			context.visitorTokenVerification,
		);
	}

	await next();
});

app.get("/visitor-token", async (c) => {
	const visitorToken = await issueAnonymousVisitorToken({
		key: c.env.VISITOR_TOKEN_KEY,
	});
	return c.json(visitorToken, 200, { "Cache-Control": "no-store" });
});

app.get("/healthz", (c) => c.text("OK", 200, { "Cache-Control": "no-store" }));

app.get("/", (c) => {
	return c.text("OK");
});

app.onError((error, c) => {
	const requestId = c.res.headers.get("X-Request-ID") ?? crypto.randomUUID();
	console.error("API request failed", {
		requestId,
		errorType: safeErrorType(error),
	});
	return c.json({ error: "INTERNAL_ERROR", requestId }, 500, {
		"X-Request-ID": requestId,
		"Cache-Control": "no-store",
	});
});

function decorateProtectedResponse(
	response: Response,
	verification: AnonymousVisitorVerification,
) {
	if (verification.status === "invalid") {
		response.headers.set("X-URLX-Visitor-Token-Refresh", "required");
	}
	if (response.status === 429) {
		response.headers.set("Retry-After", "60");
	}
	return response;
}

function safeErrorType(error: unknown) {
	if (!(error instanceof Error)) return "NonError";
	return /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(error.name) ? error.name : "Error";
}

export default app;
