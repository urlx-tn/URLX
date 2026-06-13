import type { ServerBindings } from "@urlx/api/context";
import { isValidShortCode } from "@urlx/api/lib/validate-short-code";
import { LinkRepository } from "@urlx/api/modules/links/link.repository";
import { createDb } from "@urlx/db";
import { Hono } from "hono";

type ServerHonoEnv = {
	Bindings: ServerBindings;
};

export function createRedirectRoute() {
	const route = new Hono<ServerHonoEnv>();

	route.get("/:shortCode", async (c) => {
		const shortCode = c.req.param("shortCode");

		if (!isValidShortCode(shortCode)) {
			return c.json(
				{ code: "SHORT_CODE_NOT_FOUND", message: "Short link not found." },
				404,
			);
		}

		const repository = new LinkRepository(createDb(c.env.DB));
		const link = await repository.findByShortCode(shortCode);

		if (!link) {
			return c.json(
				{ code: "SHORT_CODE_NOT_FOUND", message: "Short link not found." },
				404,
			);
		}

		if (link.disabledAt !== null) {
			return c.json(
				{ code: "SHORT_CODE_NOT_FOUND", message: "Short link not found." },
				410,
			);
		}

		c.header("Cache-Control", "no-store");
		c.header("Referrer-Policy", "no-referrer-when-downgrade");
		c.header("X-Content-Type-Options", "nosniff");

		return c.redirect(link.originalUrl, 302);
	});

	return route;
}
