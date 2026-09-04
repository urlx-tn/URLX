import { createDb } from "@urlx/db";
import type { Context as HonoContext } from "hono";

import { verifyAnonymousVisitorToken } from "./lib/anonymous-visitor";
import type { RateLimitIdentity } from "./lib/layered-rate-limit";

export const defaultShortUrlBase = "http://localhost:4321";

export type ServerBindings = {
	DB: D1Database;
	CORS_ORIGIN: string;
	METADATA_IP_RATE_LIMIT: RateLimit;
	METADATA_VISITOR_RATE_LIMIT: RateLimit;
	SHORT_URL_BASE?: string;
	VISITOR_TOKEN_KEY: CryptoKey;
};

type HonoEnv = {
	Bindings: ServerBindings;
};

export type CreateContextOptions = {
	context: HonoContext<HonoEnv>;
};

export async function createContext(options: CreateContextOptions) {
	const visitorTokenVerification = await verifyAnonymousVisitorToken(
		options.context.req.header("X-URLX-Visitor-Token"),
		options.context.env.VISITOR_TOKEN_KEY,
	);
	const rateLimitIdentity: RateLimitIdentity =
		visitorTokenVerification.status === "valid"
			? {
					kind: "visitor",
					visitorId: visitorTokenVerification.visitorId,
				}
			: { kind: "fallback-ip" };

	return {
		auth: null,
		clientIp: getClientIp(options.context.req.header()),
		db: createDb(options.context.env.DB),
		fetcher: globalThis.fetch.bind(globalThis),
		metadataIpRateLimiter: options.context.env.METADATA_IP_RATE_LIMIT,
		metadataVisitorRateLimiter: options.context.env.METADATA_VISITOR_RATE_LIMIT,
		now: () => new Date(),
		rateLimitIdentity,
		session: null,
		shortUrlBase: options.context.env.SHORT_URL_BASE ?? defaultShortUrlBase,
		visitorTokenVerification,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;

function getClientIp(headers: Record<string, string>) {
	return (
		headers["cf-connecting-ip"] ??
		headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
		"unknown"
	);
}
