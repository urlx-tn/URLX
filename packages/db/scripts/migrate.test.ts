import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { assertDatabaseIdentity } from "../src/roles";
import {
	assertMigratorIdentity,
	type MigratorIdentity,
	requireMigratorDatabaseUrl,
} from "./migrate";

describe("PostgreSQL migration runner configuration", () => {
	it("requires a non-empty migrator URL without echoing it", () => {
		expect(() => requireMigratorDatabaseUrl(undefined)).toThrow(
			"MIGRATOR_DATABASE_URL is required",
		);
		expect(() => requireMigratorDatabaseUrl("  ")).toThrow(
			"MIGRATOR_DATABASE_URL is required",
		);
		expect(requireMigratorDatabaseUrl(" postgresql://private ")).toBe(
			"postgresql://private",
		);
	});

	it("accepts the restricted migrator identity only", () => {
		expect(() => assertMigratorIdentity(identity())).not.toThrow();
		expect(() =>
			assertMigratorIdentity({ ...identity(), sessionRole: "urlx_bootstrap" }),
		).toThrow("restricted urlx_migrator role");
		expect(() =>
			assertMigratorIdentity({ ...identity(), role: "urlx_app" }),
		).toThrow("restricted urlx_migrator role");
		expect(() =>
			assertMigratorIdentity({ ...identity(), superuser: true }),
		).toThrow("restricted urlx_migrator role");
		expect(() =>
			assertMigratorIdentity({ ...identity(), createRole: true }),
		).toThrow("restricted urlx_migrator role");
		expect(() =>
			assertMigratorIdentity({ ...identity(), createDatabase: true }),
		).toThrow("restricted urlx_migrator role");
		expect(() =>
			assertMigratorIdentity({ ...identity(), replication: true }),
		).toThrow("restricted urlx_migrator role");
		expect(() =>
			assertMigratorIdentity({ ...identity(), bypassRls: true }),
		).toThrow("restricted urlx_migrator role");
	});

	it("rejects application identities with elevated session or DDL privileges", () => {
		const appIdentity = {
			...identity(),
			role: "urlx_app",
			sessionRole: "urlx_app",
			canCreateDatabase: false,
			canCreatePublicSchema: false,
		};
		expect(() => assertDatabaseIdentity(appIdentity, "urlx_app")).not.toThrow();
		expect(() =>
			assertDatabaseIdentity(
				{ ...appIdentity, canCreateDatabase: true },
				"urlx_app",
			),
		).toThrow("restricted urlx_app role");
		expect(() =>
			assertDatabaseIdentity(
				{ ...appIdentity, canCreatePublicSchema: true },
				"urlx_app",
			),
		).toThrow("restricted urlx_app role");
		expect(() =>
			assertDatabaseIdentity(
				{ ...appIdentity, sessionRole: "urlx_bootstrap" },
				"urlx_app",
			),
		).toThrow("restricted urlx_app role");
	});

	it("loads the checked-in PostgreSQL journal and statement-level quota migration", () => {
		const migrations = readMigrationFiles({
			migrationsFolder: resolve(import.meta.dir, "../src/migrations/pg"),
		});
		const quotaMigration = migrations.at(-1);
		expect(migrations).toHaveLength(5);
		expect(quotaMigration?.sql).toEqual(
			expect.arrayContaining([
				expect.stringContaining("REFERENCING NEW TABLE AS inserted_rows"),
				expect.stringContaining("forms_owner_monthly_quota"),
			]),
		);
	});
});

function identity(): MigratorIdentity {
	return {
		role: "urlx_migrator",
		sessionRole: "urlx_migrator",
		superuser: false,
		createRole: false,
		createDatabase: false,
		replication: false,
		bypassRls: false,
		canCreateDatabase: true,
		canCreatePublicSchema: true,
	};
}
