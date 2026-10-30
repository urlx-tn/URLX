import { PUBLIC_SERVER_URL } from "astro:env/client";
import { INTERNAL_SERVER_URL } from "astro:env/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "@urlx/api/routers/index";

const serverUrl =
	INTERNAL_SERVER_URL ||
	(["localhost", "127.0.0.1", "::1"].includes(
		new URL(PUBLIC_SERVER_URL).hostname,
	)
		? PUBLIC_SERVER_URL
		: "");

const link = new RPCLink({ url: `${serverUrl.replace(/\/$/, "")}/rpc` });

export const serverOrpc: AppRouterClient = createORPCClient(link);
