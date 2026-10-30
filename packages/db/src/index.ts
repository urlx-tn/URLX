import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema";

export type UrlxDb = ReturnType<typeof createPgDb>;
export type UrlxDbPool = Pool;

export function createPgPool(
	connectionString: string,
	options: Partial<Pick<PoolConfig, "max" | "options">> = {},
) {
	return new Pool({ connectionString, ...options });
}

export function createPgDb(pool: Pool) {
	return drizzle(pool, { schema });
}

export * from "./roles";
export * from "./schema";
