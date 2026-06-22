import { createDb } from "@urlx/db";
import type { Context as HonoContext } from "hono";

export const defaultShortUrlBase = "http://localhost:4321";

export type ServerBindings = {
	DB: D1Database;
	CORS_ORIGIN: string;
	METADATA_RATE_LIMIT: RateLimit;
	SHORT_URL_BASE?: string;
};

type HonoEnv = {
	Bindings: ServerBindings;
};

export type CreateContextOptions = {
	context: HonoContext<HonoEnv>;
};

export async function createContext(options: CreateContextOptions) {
	return {
		auth: null,
		db: createDb(options.context.env.DB),
		fetcher: globalThis.fetch.bind(globalThis),
		metadataRateLimiter: options.context.env.METADATA_RATE_LIMIT,
		metadataRateLimitKey: getClientIp(options.context.req.header()),
		now: () => new Date(),
		session: null,
		shortUrlBase: options.context.env.SHORT_URL_BASE ?? defaultShortUrlBase,
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
