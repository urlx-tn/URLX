import { createDb } from "@urlx/db";
import type { Context as HonoContext } from "hono";

export const defaultShortUrlBase = "http://localhost:3000";

export type ServerBindings = {
	DB: D1Database;
	CORS_ORIGIN: string;
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
		session: null,
		shortUrlBase: options.context.env.SHORT_URL_BASE ?? defaultShortUrlBase,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
