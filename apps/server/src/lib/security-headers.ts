import type { ServerBindings } from "@urlx/api/context";
import { createMiddleware } from "hono/factory";

type ServerHonoEnv = {
	Bindings: ServerBindings;
};

export const securityHeaders = createMiddleware<ServerHonoEnv>(
	async (c, next) => {
		await next();

		c.res.headers.set(
			"Content-Security-Policy",
			[
				"default-src 'self'",
				"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
				"style-src 'self' 'unsafe-inline'",
				"img-src 'self' data:",
				"connect-src 'self'",
				"frame-ancestors 'none'",
				"base-uri 'none'",
				"form-action 'none'",
			].join("; "),
		);
		c.res.headers.set(
			"Strict-Transport-Security",
			"max-age=31536000; includeSubDomains",
		);
		c.res.headers.set("X-Content-Type-Options", "nosniff");
		c.res.headers.set("Referrer-Policy", "no-referrer-when-downgrade");
		c.res.headers.set(
			"Permissions-Policy",
			"camera=(), microphone=(), geolocation=()",
		);
	},
);
