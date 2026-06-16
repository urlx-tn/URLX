import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { bioRouter } from "./bio.router";
import { linksRouter } from "./links.router";

export const appRouter = {
	healthCheck: publicProcedure.handler(() => {
		return "OK";
	}),
	links: linksRouter,
	bio: bioRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
