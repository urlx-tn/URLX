import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { ServerBindings } from "@urlx/api/context";
import { createContext } from "@urlx/api/context";
import type { AnonymousVisitorVerification } from "@urlx/api/lib/anonymous-visitor";
import { issueAnonymousVisitorToken } from "@urlx/api/lib/anonymous-visitor";
import { appRouter } from "@urlx/api/routers/index";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { securityHeaders } from "./lib/security-headers";

type ServerHonoEnv = {
	Bindings: ServerBindings;
};

const app = new Hono<ServerHonoEnv>();

app.use(logger());
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
			console.error(error);
		}),
	],
});

export const rpcHandler = new RPCHandler(appRouter, {
	interceptors: [
		onError((error) => {
			console.error(error);
		}),
	],
});

app.use("/*", async (c, next) => {
	const context = await createContext({ context: c });

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

app.get("/", (c) => {
	return c.text("OK");
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

export default app;
