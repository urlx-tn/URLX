import { PUBLIC_SERVER_URL } from "astro:env/client";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "@urlx/api/routers/index";

import {
	getAnonymousVisitorToken,
	handleVisitorTokenRefresh,
} from "./anonymous-visitor";

export const link = new RPCLink({
	url: `${PUBLIC_SERVER_URL}/rpc`,
	headers: async (_options, path) => {
		if (path[0] !== "metadata" || path[1] !== "inspect") {
			return {};
		}
		const visitorToken = await getAnonymousVisitorToken();
		return visitorToken ? { "X-URLX-Visitor-Token": visitorToken } : {};
	},
	fetch: async (request, init) => {
		const response = await fetch(request, init);
		handleVisitorTokenRefresh(response);
		return response;
	},
});

export const orpc: AppRouterClient = createORPCClient(link);
