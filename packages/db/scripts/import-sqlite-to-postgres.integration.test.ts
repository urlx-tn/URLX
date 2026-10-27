import { Database } from "bun:sqlite";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createPgDb, createPgPool, type DatabaseRoleIdentity } from "../src";
import { assertDatabaseIdentity } from "../src/roles";

const testImportDatabaseUrl = process.env.TEST_IMPORT_DATABASE_URL;
const testImportDatabaseName = process.env.TEST_IMPORT_DATABASE_NAME;
const skipWithoutImportTarget =
	!testImportDatabaseUrl && process.env.CI !== "true";
setDefaultTimeout(120_000);

describe.skipIf(skipWithoutImportTarget)(
	"SQLite importer PostgreSQL integration",
	() => {
		let pool: ReturnType<typeof createPgPool> | undefined;
		let directory = "";
		let targetReady = false;

		beforeAll(
			async () => {
				const connectionString = requireTestImportDatabaseUrl();
				pool = createPgPool(connectionString, { max: 2 });
				const { rows } = await pool.query<
					DatabaseRoleIdentity & { database: string }
				>(`
				SELECT current_database() AS database,
					current_user AS role,
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
				const target = rows[0];
				if (!target)
					throw new Error("Unable to validate import test database role");
				if (
					testImportDatabaseName !== "urlx_import_test" ||
					target.database !== testImportDatabaseName
				)
					throw new Error(
						"TEST_IMPORT_DATABASE_URL must target urlx_import_test",
					);
				assertDatabaseIdentity(target, "urlx_migrator");
				await migrate(createPgDb(pool), {
					migrationsFolder: fileURLToPath(
						new URL("../src/migrations/pg/", import.meta.url),
					),
				});
				targetReady = true;
				await cleanSyntheticImportTarget(pool);
				await expectEmptyImportTarget(pool);
				directory = await mkdtemp(
					join(tmpdir(), "urlx-pg-import-integration-"),
				);
			},
			{ timeout: 120_000 },
		);

		afterAll(
			async () => {
				try {
					if (pool && targetReady) await cleanSyntheticImportTarget(pool);
				} finally {
					await pool?.end();
					if (directory) await rm(directory, { recursive: true, force: true });
				}
			},
			{ timeout: 120_000 },
		);

		it("rolls back a malformed apply, then imports and reconciles the source data", async () => {
			if (!pool) throw new Error("Import test database is not initialized");
			const malformedSnapshot = join(directory, "malformed.sqlite");
			createSnapshot(malformedSnapshot, { malformedLinkTimestamp: true });
			const malformedApply = runImporter(malformedSnapshot, true);
			expect(malformedApply.status).not.toBe(0);
			expect(malformedApply.output).not.toContain("synthetic@example.invalid");
			expect(malformedApply.output).not.toContain("synthetic-session-token");
			await expectEmptyImportTarget(pool);

			const validSnapshot = join(directory, "valid.sqlite");
			createSnapshot(validSnapshot);
			const dryRun = runImporter(validSnapshot, false);
			expect(dryRun.status, dryRun.output).toBe(0);
			expect(parseImporterReport(dryRun.output).mode).toBe("dry-run");
			expect(dryRun.output).not.toContain("synthetic@example.invalid");
			expect(dryRun.output).not.toContain("synthetic-session-token");

			const apply = runImporter(validSnapshot, true);
			expect(apply.status).toBe(0);
			const applyReport = parseImporterReport(apply.output);
			expect(applyReport.mode).toBe("applied-and-reconciled");
			expect(applyReport.foreignKeys).toBe("consistent");
			const imported = await pool.query<{
				email: string;
				token: string;
				expires_at: Date;
				usage_count: number;
				response_count: string;
				links_count: string;
				bio_links_count: string;
				tombstones_count: string;
			}>(`
				SELECT u.email, s.token, s.expires_at,
					usage.response_count AS usage_count,
					(SELECT count(*)::text FROM public.form_responses r WHERE r.form_id = 'synthetic-form') AS response_count,
					(SELECT count(*)::text FROM public.links) AS links_count,
					(SELECT count(*)::text FROM public.bio_links) AS bio_links_count,
					(SELECT count(*)::text FROM public.form_alias_tombstones) AS tombstones_count
				FROM public."user" u
				JOIN public.session s ON s.user_id = u.id
				JOIN public.form_monthly_usage usage ON usage.owner_id = u.id
				WHERE u.id = 'synthetic-user' AND usage.month = '2026-10'
			`);
			expect(imported.rows).toEqual([
				{
					email: "synthetic@example.invalid",
					token: "synthetic-session-token",
					expires_at: new Date(Date.UTC(2026, 9, 31, 23, 59, 59, 999)),
					usage_count: 1,
					response_count: "1",
					links_count: "1",
					bio_links_count: "1",
					tombstones_count: "1",
				},
			]);
			const monthlyUsage = await pool.query<{
				month: string;
				response_count: number;
			}>(`
				SELECT month, response_count
				FROM public.form_monthly_usage
				WHERE owner_id = 'synthetic-user'
				ORDER BY month
			`);
			expect(monthlyUsage.rows).toEqual([
				{ month: "2026-10", response_count: 1 },
				{ month: "2026-11", response_count: 1 },
			]);
		});
	},
);

function requireTestImportDatabaseUrl() {
	if (!testImportDatabaseUrl)
		throw new Error("TEST_IMPORT_DATABASE_URL is required");
	return testImportDatabaseUrl;
}

function parseImporterReport(output: string) {
	return JSON.parse(output) as {
		mode: string;
		foreignKeys?: string;
	};
}

function runImporter(snapshot: string, apply: boolean) {
	const args = [
		resolve(import.meta.dir, "import-sqlite-to-postgres.ts"),
		"--source",
		snapshot,
	];
	if (apply) args.push("--apply", "--confirm-empty-target", "urlx_import_test");
	try {
		const output = execFileSync("bun", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, MIGRATOR_DATABASE_URL: testImportDatabaseUrl },
		});
		return { status: 0, output };
	} catch (error) {
		const child = error as {
			status?: number | null;
			stdout?: Buffer | string;
			stderr?: Buffer | string;
		};
		return {
			status: child.status ?? 1,
			output: `${child.stdout?.toString() ?? ""}${child.stderr?.toString() ?? ""}`,
		};
	}
}

function createSnapshot(
	path: string,
	options: { malformedLinkTimestamp?: boolean } = {},
) {
	const database = new Database(path);
	try {
		database.exec("PRAGMA foreign_keys = ON");
		for (const name of [
			"0000_faulty_iron_patriot.sql",
			"0001_handy_shocker.sql",
			"0002_forms_auth.sql",
			"0003_respondent_access.sql",
		]) {
			const migrationPath = fileURLToPath(
				new URL(`../src/migrations/${name}`, import.meta.url),
			);
			const migration = readFileSync(migrationPath, "utf8");
			for (const statement of migration.split("--> statement-breakpoint")) {
				if (statement.trim()) database.exec(statement);
			}
		}
		seedSyntheticData(database, options.malformedLinkTimestamp ?? false);
	} finally {
		database.close();
	}
}

function seedSyntheticData(
	database: Database,
	malformedLinkTimestamp: boolean,
) {
	const timestamp = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
	database
		.query(
			`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
			 VALUES ('synthetic-user', 'Synthetic User', 'synthetic@example.invalid', 1, ?, ?)`,
		)
		.run(timestamp, timestamp);
	database
		.query(
			`INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
			 VALUES ('synthetic-session', ?, 'synthetic-session-token', ?, ?, 'synthetic-user')`,
		)
		.run(timestamp, timestamp, timestamp);
	database
		.query(
			`INSERT INTO forms (id, owner_id, title, created_at, updated_at)
			 VALUES ('synthetic-form', 'synthetic-user', 'Synthetic form', ?, ?)`,
		)
		.run(timestamp, timestamp);
	database
		.query(
			`INSERT INTO form_versions
			(id, form_id, version, fields_json, title, accent, respondent_access, created_at, published_at)
			 VALUES ('synthetic-version', 'synthetic-form', 1, '[]', 'Synthetic form', 'blue', 'public', ?, ?)`,
		)
		.run(timestamp, timestamp);
	database
		.query(
			`INSERT INTO form_aliases (alias, form_id, created_at)
			 VALUES ('deleted-alias', 'synthetic-form', ?)`,
		)
		.run(timestamp);
	database
		.query(
			`INSERT INTO form_responses
			(id, form_id, version_id, idempotency_key, answers_json, created_at)
			 VALUES ('deleted-response', 'synthetic-form', 'synthetic-version', 'deleted-key', '{}', ?)`,
		)
		.run(timestamp);
	database
		.query("DELETE FROM form_responses WHERE id = 'deleted-response'")
		.run();
	database
		.query(
			`INSERT INTO form_responses
			(id, form_id, version_id, idempotency_key, answers_json, created_at)
			 VALUES ('retained-response', 'synthetic-form', 'synthetic-version', 'retained-key', '{"choice":"a"}', ?)`,
		)
		.run(timestamp + 1);
	database
		.query(
			`INSERT INTO bio_pages (id, slug, title, created_at, updated_at)
			 VALUES ('synthetic-bio', 'synthetic-bio', 'Synthetic bio', ?, ?)`,
		)
		.run(timestamp, timestamp);
	database
		.query(
			`INSERT INTO bio_links (id, page_id, label, url, position, created_at)
			 VALUES ('synthetic-bio-link', 'synthetic-bio', 'Home', 'https://example.invalid', 0, ?)`,
		)
		.run(timestamp);
	database
		.query(
			`INSERT INTO links (id, short_code, original_url, normalized_url, url_hash, created_at, updated_at)
			 VALUES ('synthetic-link', 'syn001', 'https://example.invalid', 'https://example.invalid', 'synthetic-hash', ?, ?)`,
		)
		.run(timestamp, malformedLinkTimestamp ? 1.5 : timestamp);
	database
		.query(
			`INSERT INTO forms (id, owner_id, title, created_at, updated_at)
			 VALUES ('deleted-form', 'synthetic-user', 'Deleted form', ?, ?)`,
		)
		.run(timestamp, timestamp);
	database
		.query(
			`INSERT INTO form_aliases (alias, form_id, created_at)
			 VALUES ('historical-alias', 'deleted-form', ?)`,
		)
		.run(timestamp);
	database.query("DELETE FROM forms WHERE id = 'deleted-form'").run();
}

async function expectEmptyImportTarget(pool: ReturnType<typeof createPgPool>) {
	for (const table of [
		'"user"',
		"session",
		"account",
		"verification",
		"links",
		"bio_pages",
		"bio_links",
		"forms",
		"form_versions",
		"form_aliases",
		"form_alias_tombstones",
		"form_owner_locks",
		"form_alias_locks",
		"form_responses",
		"form_monthly_usage",
	]) {
		const result = await pool.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM public.${table}`,
		);
		expect(result.rows[0]?.count).toBe("0");
	}
	const limits = await pool.query<{
		id: number;
		max_monthly_responses: number;
	}>("SELECT id, max_monthly_responses FROM public.form_limits");
	expect(limits.rows).toEqual([{ id: 1, max_monthly_responses: 1000 }]);
}

async function cleanSyntheticImportTarget(
	pool: ReturnType<typeof createPgPool>,
) {
	await pool.query("BEGIN");
	try {
		const limits = await pool.query<{
			id: number;
			max_published: number;
			max_monthly_responses: number;
			max_retained_responses: number;
		}>(
			"SELECT id, max_published, max_monthly_responses, max_retained_responses FROM public.form_limits ORDER BY id",
		);
		if (
			limits.rows.length !== 1 ||
			limits.rows[0]?.id !== 1 ||
			limits.rows[0]?.max_published !== 25 ||
			limits.rows[0]?.max_monthly_responses !== 1000 ||
			limits.rows[0]?.max_retained_responses !== 10000
		)
			throw new Error("Importer fixture form limits are not recognized");
		await pool.query('DELETE FROM public."user" WHERE id = $1', [
			"synthetic-user",
		]);
		await pool.query("DELETE FROM public.links WHERE id = $1", [
			"synthetic-link",
		]);
		await pool.query("DELETE FROM public.bio_links WHERE id = $1", [
			"synthetic-bio-link",
		]);
		await pool.query("DELETE FROM public.bio_pages WHERE id = $1", [
			"synthetic-bio",
		]);
		await pool.query(
			"DELETE FROM public.form_alias_tombstones WHERE alias = ANY($1::text[])",
			[["deleted-alias", "historical-alias"]],
		);
		await pool.query("DELETE FROM public.form_alias_locks WHERE alias = $1", [
			"deleted-alias",
		]);
		await pool.query(
			`UPDATE public.form_limits
			 SET max_published = 25, max_monthly_responses = 1000, max_retained_responses = 10000
			 WHERE id = 1`,
		);
		await pool.query("COMMIT");
	} catch (error) {
		await pool.query("ROLLBACK").catch(() => undefined);
		throw error;
	}
}
