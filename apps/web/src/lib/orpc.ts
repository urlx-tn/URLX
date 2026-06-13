import { PUBLIC_SERVER_URL } from "astro:env/client";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "@urlx/api/routers/index";

export const link = new RPCLink({
	url: `${PUBLIC_SERVER_URL}/rpc`,
});

export const orpc: AppRouterClient = createORPCClient(link);
