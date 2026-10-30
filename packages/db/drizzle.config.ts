import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/schema/index.ts",
	out: "./src/migrations/pg",
	dialect: "postgresql",
	dbCredentials: {
		// Never fall back to the restricted API role for schema migrations.
		url: process.env.MIGRATOR_DATABASE_URL ?? "postgresql://localhost/urlx",
	},
});
