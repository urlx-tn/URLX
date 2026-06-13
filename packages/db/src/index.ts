import { env } from "@urlx/env/server";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema";

export function createDb(database: D1Database = env.DB) {
	return drizzle(database, { schema });
}

export * from "./schema";
