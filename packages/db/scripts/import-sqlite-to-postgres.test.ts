import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
	assertImporterTargetIdentity,
	inspectSQLiteSnapshot,
	normalizeSQLiteRow,
	openSQLiteSnapshot,
	sqliteImportTables,
} from "./import-sqlite-to-postgres";

describe("SQLite snapshot import preflight", () => {
	let directory = "";
	let snapshot = "";
	let database: Database;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "urlx-sqlite-import-"));
		snapshot = join(directory, "synthetic-d1.sqlite");
		database = new Database(snapshot);
		database.exec("PRAGMA foreign_keys = ON");
		for (const name of [
			"0000_faulty_iron_patriot.sql",
			"0001_handy_shocker.sql",
			"0002_forms_auth.sql",
			"0003_respondent_access.sql",
		]) {
			const path = fileURLToPath(
				new URL(`../src/migrations/${name}`, import.meta.url),
			);
			const migration = await readFile(path, "utf8");
			for (const statement of migration.split("--> statement-breakpoint")) {
				if (statement.trim()) database.exec(statement);
			}
		}
		seedSyntheticSnapshot(database);
	});

	afterEach(async () => {
		database?.close();
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = "";
	});

	it("validates current D1 schema and summarizes IDs without exposing row content", async () => {
		const { summary, formLimits } = await inspectSQLiteSnapshot(snapshot);
		expect(summary.user?.rows).toBe(1);
		expect(summary.session?.rows).toBe(1);
		expect(summary.forms?.rows).toBe(1);
		expect(summary.form_versions?.rows).toBe(1);
		expect(summary.form_responses?.rows).toBe(1);
		expect(summary.form_aliases?.rows).toBe(1);
		expect(summary.form_alias_tombstones?.rows).toBe(1);
		expect(summary.form_monthly_usage?.rows).toBe(2);
		expect(summary.form_limits?.rows).toBe(1);
		expect(summary.user?.keyChecksum).toMatch(/^[a-f0-9]{64}$/);
		expect(formLimits).toEqual([
			{
				id: 1,
				max_published: 25,
				max_monthly_responses: 1000,
				max_retained_responses: 10000,
			},
		]);
		const report = JSON.stringify({ summary, formLimits });
		expect(report).not.toContain("synthetic@example.invalid");
		expect(report).not.toContain("synthetic-session-token");
	});

	it("preserves the monthly accepted count after a response was deleted", () => {
		const usage = database
			.query<{ month: string; response_count: number }, []>(
				"SELECT month, response_count FROM form_monthly_usage WHERE owner_id = 'synthetic-user' ORDER BY month",
			)
			.all();
		expect(usage).toEqual([
			{ month: "2026-10", response_count: 1 },
			{ month: "2026-11", response_count: 1 },
		]);
		expect(
			database
				.query<{ count: number }, []>(
					"SELECT count(*) AS count FROM form_responses",
				)
				.get()?.count,
		).toBe(1);
	});

	it("converts auth epoch milliseconds to exact timestamptz instants", () => {
		const table = sqliteImportTables.find(
			(candidate) => candidate.name === "session",
		);
		if (!table) throw new Error("Session import mapping is missing");
		const row = database
			.query<Record<string, unknown>, []>(
				"SELECT * FROM session WHERE id = 'synthetic-session'",
			)
			.get();
		if (!row) throw new Error("Synthetic session was not seeded");
		const normalized = normalizeSQLiteRow(table, row);
		expect(normalized.expires_at).toBeInstanceOf(Date);
		expect((normalized.expires_at as Date).getTime()).toBe(
			Date.UTC(2026, 9, 31, 23, 59, 59, 999),
		);
	});

	it("fails closed when an expected source column is missing", async () => {
		database.exec("ALTER TABLE bio_pages RENAME TO bio_pages_original");
		database.exec("CREATE TABLE bio_pages (id text PRIMARY KEY)");
		await expect(inspectSQLiteSnapshot(snapshot)).rejects.toThrow(
			/does not match expected bio_pages layout/,
		);
	});

	it("keeps one read snapshot stable while another connection commits a write", () => {
		database.query("PRAGMA journal_mode = WAL").get();
		const snapshotView = openSQLiteSnapshot(snapshot);
		try {
			const before = snapshotView
				.query<{ title: string }, []>(
					"SELECT title FROM forms WHERE id = 'synthetic-form'",
				)
				.get();
			expect(before?.title).toBe("Synthetic form");

			database
				.query("UPDATE forms SET title = 'Changed after snapshot' WHERE id = ?")
				.run("synthetic-form");

			const after = snapshotView
				.query<{ title: string }, []>(
					"SELECT title FROM forms WHERE id = 'synthetic-form'",
				)
				.get();
			expect(after?.title).toBe("Synthetic form");
			expect(
				database
					.query<{ title: string }, [string]>(
						"SELECT title FROM forms WHERE id = ?",
					)
					.get("synthetic-form")?.title,
			).toBe("Changed after snapshot");
		} finally {
			snapshotView.exec("ROLLBACK");
			snapshotView.close();
		}
	});
});

describe("SQLite importer PostgreSQL target role guard", () => {
	const identity = {
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

	it("accepts only the direct restricted migration role", () => {
		expect(() => assertImporterTargetIdentity(identity)).not.toThrow();
		for (const unsafeIdentity of [
			{ ...identity, sessionRole: "urlx_bootstrap" },
			{ ...identity, role: "urlx_app" },
			{ ...identity, superuser: true },
			{ ...identity, createRole: true },
			{ ...identity, createDatabase: true },
			{ ...identity, replication: true },
			{ ...identity, bypassRls: true },
		]) {
			expect(() => assertImporterTargetIdentity(unsafeIdentity)).toThrow(
				"restricted urlx_migrator role",
			);
		}
	});
});

function seedSyntheticSnapshot(database: Database) {
	const instant = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
	database
		.query(
			`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
		 VALUES ('synthetic-user', 'Synthetic User', 'synthetic@example.invalid', 1, ?, ?)`,
		)
		.run(instant, instant);
	database
		.query(
			`INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
		 VALUES ('synthetic-session', ?, 'synthetic-session-token', ?, ?, 'synthetic-user')`,
		)
		.run(instant, instant, instant);
	database
		.query(
			`INSERT INTO forms (id, owner_id, title, created_at, updated_at)
		 VALUES ('synthetic-form', 'synthetic-user', 'Synthetic form', ?, ?)`,
		)
		.run(instant, instant);
	database
		.query(
			`INSERT INTO form_versions
			(id, form_id, version, fields_json, title, accent, respondent_access, created_at, published_at)
		 VALUES ('synthetic-version', 'synthetic-form', 1, '[]', 'Synthetic form', 'blue', 'public', ?, ?)`,
		)
		.run(instant, instant);
	database
		.query(
			`INSERT INTO form_aliases (alias, form_id, created_at)
		 VALUES ('deleted-alias', 'synthetic-form', ?)`,
		)
		.run(instant);
	database
		.query(
			`INSERT INTO form_responses
			(id, form_id, version_id, idempotency_key, answers_json, created_at)
		 VALUES ('deleted-response', 'synthetic-form', 'synthetic-version', 'deleted-key', '{}', ?)`,
		)
		.run(instant);
	database
		.query("DELETE FROM form_responses WHERE id = 'deleted-response'")
		.run();
	database
		.query(
			`INSERT INTO form_responses
			(id, form_id, version_id, idempotency_key, answers_json, created_at)
		 VALUES ('retained-response', 'synthetic-form', 'synthetic-version', 'retained-key', '{"choice":"a"}', ?)`,
		)
		.run(instant + 1);
	database
		.query(
			`INSERT INTO bio_pages (id, slug, title, created_at, updated_at)
		 VALUES ('synthetic-bio', 'synthetic-bio', 'Synthetic bio', ?, ?)`,
		)
		.run(instant, instant);
	database
		.query(
			`INSERT INTO bio_links (id, page_id, label, url, position, created_at)
		 VALUES ('synthetic-bio-link', 'synthetic-bio', 'Home', 'https://example.invalid', 0, ?)`,
		)
		.run(instant);
	database
		.query(
			`INSERT INTO links (id, short_code, original_url, normalized_url, url_hash, created_at, updated_at)
		 VALUES ('synthetic-link', 'syn001', 'https://example.invalid', 'https://example.invalid', 'synthetic-hash', ?, ?)`,
		)
		.run(instant, instant);
	// Deleting a second form records the old alias in the source tombstone table.
	database
		.query(
			`INSERT INTO forms (id, owner_id, title, created_at, updated_at)
		 VALUES ('deleted-form', 'synthetic-user', 'Deleted form', ?, ?)`,
		)
		.run(instant, instant);
	database
		.query(
			`INSERT INTO form_aliases (alias, form_id, created_at)
		 VALUES ('historical-alias', 'deleted-form', ?)`,
		)
		.run(instant);
	database.query("DELETE FROM forms WHERE id = 'deleted-form'").run();
}
