import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
	assertDatabaseIdentity,
	type DatabaseRoleIdentity,
} from "../src/roles";

export type MigratorIdentity = DatabaseRoleIdentity;

export function requireMigratorDatabaseUrl(value: string | undefined): string {
	if (!value?.trim()) throw new Error("MIGRATOR_DATABASE_URL is required");
	return value.trim();
}

export function assertMigratorIdentity(identity: MigratorIdentity): void {
	assertDatabaseIdentity(identity, "urlx_migrator");
}

export async function runMigrations(databaseUrl: string): Promise<void> {
	const pool = new Pool({
		connectionString: databaseUrl,
		application_name: "urlx-db-migrate",
		max: 1,
	});
	try {
		const identity = await pool.query<MigratorIdentity>(`
			SELECT current_user AS role,
				session_user AS "sessionRole",
				roles.rolsuper AS superuser,
				roles.rolcreaterole AS "createRole",
				roles.rolcreatedb AS "createDatabase",
				roles.rolreplication AS replication,
				roles.rolbypassrls AS "bypassRls",
				has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabase",
				has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreatePublicSchema"
			FROM pg_catalog.pg_roles AS roles
			WHERE roles.rolname = current_user
		`);
		const row = identity.rows[0];
		if (!row) throw new Error("Unable to validate the migration role");
		assertMigratorIdentity(row);

		const db = drizzle({ client: pool });
		await migrate(db, {
			migrationsFolder: resolve(import.meta.dir, "../src/migrations/pg"),
			migrationsSchema: "drizzle",
		});
	} finally {
		await pool.end();
	}
}

async function main() {
	const databaseUrl = requireMigratorDatabaseUrl(
		process.env.MIGRATOR_DATABASE_URL,
	);
	await runMigrations(databaseUrl);
	console.log("Database migrations applied.");
}

if (import.meta.main) {
	main().catch(() => {
		if (!process.env.MIGRATOR_DATABASE_URL?.trim()) {
			console.error("MIGRATOR_DATABASE_URL is required");
		} else {
			console.error("Database migration failed; no query details were logged.");
		}
		process.exitCode = 1;
	});
}
