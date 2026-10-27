import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/schema/sqlite.ts",
	out: "./src/migrations",
	// DOCS: https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit
	dialect: "sqlite",
	driver: "d1-http",
});
