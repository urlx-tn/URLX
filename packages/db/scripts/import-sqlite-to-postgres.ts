import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Client, type QueryResultRow } from "pg";
import {
	assertDatabaseIdentity,
	type DatabaseRoleIdentity,
} from "../src/roles";

const pageSize = 100;
const pgParameterLimit = 65_535;

type Row = Record<string, unknown>;
type TableSpec = {
	name: string;
	columns: string[];
	key: string[];
	dateColumns?: string[];
	booleanColumns?: string[];
	numberColumns?: string[];
};

export const sqliteImportTables: TableSpec[] = [
	{
		name: "user",
		key: ["id"],
		columns: [
			"id",
			"name",
			"email",
			"email_verified",
			"image",
			"created_at",
			"updated_at",
		],
		dateColumns: ["created_at", "updated_at"],
		booleanColumns: ["email_verified"],
	},
	{
		name: "session",
		key: ["id"],
		columns: [
			"id",
			"expires_at",
			"token",
			"created_at",
			"updated_at",
			"ip_address",
			"user_agent",
			"user_id",
		],
		dateColumns: ["expires_at", "created_at", "updated_at"],
	},
	{
		name: "account",
		key: ["id"],
		columns: [
			"id",
			"account_id",
			"provider_id",
			"user_id",
			"access_token",
			"refresh_token",
			"id_token",
			"access_token_expires_at",
			"refresh_token_expires_at",
			"scope",
			"password",
			"created_at",
			"updated_at",
		],
		dateColumns: [
			"access_token_expires_at",
			"refresh_token_expires_at",
			"created_at",
			"updated_at",
		],
	},
	{
		name: "verification",
		key: ["id"],
		columns: [
			"id",
			"identifier",
			"value",
			"expires_at",
			"created_at",
			"updated_at",
		],
		dateColumns: ["expires_at", "created_at", "updated_at"],
	},
	{
		name: "links",
		key: ["id"],
		columns: [
			"id",
			"short_code",
			"original_url",
			"normalized_url",
			"url_hash",
			"created_at",
			"updated_at",
			"disabled_at",
		],
		numberColumns: ["created_at", "updated_at", "disabled_at"],
	},
	{
		name: "bio_pages",
		key: ["id"],
		columns: [
			"id",
			"slug",
			"title",
			"description",
			"created_at",
			"updated_at",
			"disabled_at",
		],
		numberColumns: ["created_at", "updated_at", "disabled_at"],
	},
	{
		name: "bio_links",
		key: ["id"],
		columns: ["id", "page_id", "label", "url", "position", "created_at"],
		numberColumns: ["position", "created_at"],
	},
	{
		name: "forms",
		key: ["id"],
		columns: [
			"id",
			"owner_id",
			"title",
			"description",
			"theme",
			"accent",
			"confirmation_message",
			"slug",
			"short_code",
			"created_at",
			"updated_at",
			"disabled_at",
		],
		numberColumns: ["created_at", "updated_at", "disabled_at"],
	},
	{
		name: "form_versions",
		key: ["id"],
		columns: [
			"id",
			"form_id",
			"version",
			"fields_json",
			"title",
			"description",
			"confirmation_message",
			"accent",
			"respondent_access",
			"created_at",
			"published_at",
		],
		numberColumns: ["version", "created_at", "published_at"],
	},
	{
		name: "form_aliases",
		key: ["alias"],
		columns: ["alias", "form_id", "created_at"],
		numberColumns: ["created_at"],
	},
	{
		name: "form_alias_tombstones",
		key: ["alias"],
		columns: ["alias", "created_at"],
		numberColumns: ["created_at"],
	},
	{
		name: "form_responses",
		key: ["id"],
		columns: [
			"id",
			"form_id",
			"version_id",
			"idempotency_key",
			"answers_json",
			"created_at",
		],
		numberColumns: ["created_at"],
	},
	{
		name: "form_monthly_usage",
		key: ["owner_id", "month"],
		columns: ["owner_id", "month", "response_count"],
		numberColumns: ["response_count"],
	},
	{
		name: "form_limits",
		key: ["id"],
		columns: [
			"id",
			"max_published",
			"max_monthly_responses",
			"max_retained_responses",
		],
		numberColumns: [
			"id",
			"max_published",
			"max_monthly_responses",
			"max_retained_responses",
		],
	},
];

const targetGuardTables = ["form_owner_locks", "form_alias_locks"] as const;
const pgTimeColumns = new Set(
	sqliteImportTables.flatMap((table) =>
		(table.dateColumns ?? []).map((column) => `${table.name}.${column}`),
	),
);

export type TableSummary = {
	rows: number;
	keyChecksum: string;
};

export function assertImporterTargetIdentity(
	identity: DatabaseRoleIdentity,
): void {
	assertDatabaseIdentity(identity, "urlx_migrator");
}

export function openSQLiteSnapshot(snapshotPath: string) {
	const database = new Database(snapshotPath, { readonly: true });
	try {
		database.exec("BEGIN DEFERRED");
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

export async function inspectSQLiteSnapshot(
	snapshotPath: string,
	connection?: Database,
) {
	const database = connection ?? openSQLiteSnapshot(snapshotPath);
	try {
		const integrity = database
			.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
			.get();
		if (integrity?.integrity_check !== "ok")
			throw new Error("SQLite snapshot integrity check failed");
		const foreignKeyErrors = database.query("PRAGMA foreign_key_check").all();
		if (foreignKeyErrors.length > 0)
			throw new Error("SQLite snapshot contains foreign-key violations");

		const summary: Record<string, TableSummary> = {};
		for (const table of sqliteImportTables) {
			validateSQLiteTable(database, table);
			summary[table.name] = summarizeSQLiteTable(database, table);
		}
		const limitRows = database
			.query<Row, []>(
				"SELECT id, max_published, max_monthly_responses, max_retained_responses FROM form_limits ORDER BY id",
			)
			.all();
		if (!limitRows.some((row) => row.id === 1))
			throw new Error("SQLite snapshot is missing form_limits id 1");
		return { summary, formLimits: limitRows };
	} finally {
		if (!connection) {
			database.exec("ROLLBACK");
			database.close();
		}
	}
}

export function normalizeSQLiteRow(table: TableSpec, source: Row): Row {
	const row: Row = {};
	for (const column of table.columns) {
		const value = source[column];
		if ((table.dateColumns ?? []).includes(column)) {
			if (value === null || value === undefined) {
				row[column] = null;
			} else {
				const milliseconds = Number(value);
				if (!Number.isSafeInteger(milliseconds))
					throw new Error(
						"SQLite timestamp is outside the supported millisecond range",
					);
				const date = new Date(milliseconds);
				if (!Number.isFinite(date.getTime()))
					throw new Error("SQLite timestamp is invalid");
				row[column] = date;
			}
		} else if ((table.booleanColumns ?? []).includes(column)) {
			if (value !== 0 && value !== 1 && value !== false && value !== true)
				throw new Error("SQLite boolean column has an invalid value");
			row[column] = value === true || value === 1;
		} else if (
			(table.numberColumns ?? []).includes(column) &&
			value !== null &&
			value !== undefined
		) {
			const number = Number(value);
			if (!Number.isSafeInteger(number))
				throw new Error("SQLite integer is outside the supported safe range");
			row[column] = number;
		} else {
			row[column] = value;
		}
	}
	return row;
}

export function normalizedRowForMac(table: TableSpec, row: Row): string {
	return JSON.stringify(
		table.columns.map((column) => {
			const value = row[column];
			if (value instanceof Date) return value.getTime();
			if (typeof value === "bigint") return value.toString();
			return value;
		}),
	);
}

async function runCli(args: string[]) {
	const options = parseArgs(args);
	const snapshot = await realpath(options.source);
	const repoRoot = resolve(import.meta.dir, "../../..");
	const relativeSource = relative(repoRoot, snapshot);
	const sourceIsInsideCheckout =
		relativeSource === "" ||
		(!isAbsolute(relativeSource) &&
			relativeSource !== ".." &&
			!relativeSource.startsWith(`..${sep}`));
	if (!isAbsolute(snapshot) || sourceIsInsideCheckout)
		throw new Error("SQLite snapshot must be outside the checkout");
	const source = openSQLiteSnapshot(snapshot);
	try {
		const inspected = await inspectSQLiteSnapshot(snapshot, source);
		if (options.sourceOnly) {
			printReport({ mode: "source-verified", tables: inspected.summary });
			return;
		}

		const connectionString = process.env.MIGRATOR_DATABASE_URL;
		if (!connectionString) throw new Error("MIGRATOR_DATABASE_URL is required");
		const client = new Client({
			connectionString,
			application_name: "urlx-sqlite-import",
		});
		try {
			await client.connect();
			const target = await validateTarget(client);
			if (
				options.confirmDatabase !== undefined &&
				options.confirmDatabase !== target.database
			)
				throw new Error(
					"Confirmation database name does not match the connection target",
				);
			if (options.apply && !options.confirmDatabase)
				throw new Error(
					"Apply requires --confirm-empty-target with the exact database name",
				);

			if (!options.apply) {
				await assertEmptyTarget(client);
				printReport({
					mode: "dry-run",
					targetDatabase: target.database,
					targetRole: target.role,
					tables: inspected.summary,
					applyCommand: `--apply --confirm-empty-target ${target.database}`,
				});
				return;
			}

			const transactionMacKey = randomBytes(32);
			await client.query("BEGIN");
			try {
				await lockTargetTables(client);
				await assertEmptyTarget(client);
				await client.query(
					"ALTER TABLE public.form_responses DISABLE TRIGGER USER",
				);
				for (const table of sqliteImportTables) {
					if (table.name === "form_limits") continue;
					await copyTable(client, source, table, transactionMacKey);
				}
				await copyFormLimits(client, source);
				await client.query(
					"ALTER TABLE public.form_responses ENABLE TRIGGER USER",
				);
				const reconciliation = await reconcileTarget(
					client,
					source,
					transactionMacKey,
				);
				await verifyForeignKeys(client);
				await client.query("COMMIT");
				printReport({
					mode: "applied-and-reconciled",
					targetDatabase: target.database,
					tables: reconciliation,
					foreignKeys: "consistent",
				});
			} catch (error) {
				await client.query("ROLLBACK").catch(() => undefined);
				throw error;
			}
		} finally {
			await client.end();
		}
	} finally {
		source.exec("ROLLBACK");
		source.close();
	}
}

function parseArgs(args: string[]) {
	let source: string | undefined;
	let apply = false;
	let sourceOnly = false;
	let confirmDatabase: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--source") source = args[++index];
		else if (argument === "--apply") apply = true;
		else if (argument === "--source-only") sourceOnly = true;
		else if (argument === "--confirm-empty-target")
			confirmDatabase = args[++index];
		else if (argument === "--help") {
			console.log(
				"Usage: db:import-sqlite -- --source <external.sqlite> [--apply --confirm-empty-target <database>]",
			);
			process.exit(0);
		} else throw new Error("Unknown or incomplete importer option");
	}
	if (!source || !isAbsolute(source))
		throw new Error(
			"--source must be an absolute path to an SQLite snapshot outside the checkout",
		);
	if (sourceOnly && (apply || confirmDatabase))
		throw new Error(
			"--source-only cannot be combined with apply or target confirmation",
		);
	return { source, apply, sourceOnly, confirmDatabase };
}

async function validateTarget(client: Client) {
	const result = await client.query<
		DatabaseRoleIdentity & { database: string }
	>(`SELECT current_database() AS database,
		current_user AS role,
		session_user AS "sessionRole",
		roles.rolsuper AS superuser,
		roles.rolcreaterole AS "createRole",
		roles.rolcreatedb AS "createDatabase",
		roles.rolreplication AS replication,
		roles.rolbypassrls AS "bypassRls",
		has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabase",
		has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreatePublicSchema"
		FROM pg_catalog.pg_roles AS roles WHERE roles.rolname = current_user`);
	const target = result.rows[0];
	if (!target) throw new Error("Unable to validate the importer target role");
	assertImporterTargetIdentity(target);
	return target;
}

async function assertEmptyTarget(client: Client) {
	const targetTables = [
		...sqliteImportTables
			.filter((table) => table.name !== "form_limits")
			.map((table) => table.name),
		...targetGuardTables,
	];
	for (const name of targetTables) {
		const result = await client.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM public.${quotePg(name)}`,
		);
		if (result.rows[0]?.count !== "0")
			throw new Error(
				"Importer target contains application data; refusing to continue",
			);
	}
	const limits = await client.query<Row>(
		"SELECT id, max_published, max_monthly_responses, max_retained_responses FROM public.form_limits ORDER BY id",
	);
	if (
		limits.rows.length !== 1 ||
		Number(limits.rows[0]?.id) !== 1 ||
		Number(limits.rows[0]?.max_published) !== 25 ||
		Number(limits.rows[0]?.max_monthly_responses) !== 1000 ||
		Number(limits.rows[0]?.max_retained_responses) !== 10000
	) {
		throw new Error(
			"Importer target form_limits are not at the fresh-migration defaults",
		);
	}
}

async function lockTargetTables(client: Client) {
	const names = [
		...sqliteImportTables.map((table) => table.name),
		...targetGuardTables,
	].sort();
	await client.query(
		`LOCK TABLE ${names.map((name) => `public.${quotePg(name)}`).join(", ")} IN ACCESS EXCLUSIVE MODE`,
	);
}

async function copyTable(
	client: Client,
	source: Database,
	table: TableSpec,
	macKey: Uint8Array,
) {
	const sourceMac = createHmac("sha256", macKey);
	const targetMac = createHmac("sha256", macKey);
	let lastKey: SQLQueryBindings[] | undefined;
	let sourceRows = 0;
	for (;;) {
		const rows = readSQLitePage(source, table, lastKey);
		if (!rows.length) break;
		const normalized = rows.map((row) => normalizeSQLiteRow(table, row));
		for (const row of normalized) {
			sourceRows += 1;
			sourceMac.update(normalizedRowForMac(table, row)).update("\n");
		}
		if (table.name === "form_limits") {
			for (const row of normalized) {
				if (Number(row.id) !== 1) await insertRows(client, table, [row]);
			}
		} else {
			await insertRows(client, table, normalized);
		}
		const lastRow = rows.at(-1);
		if (!lastRow) throw new Error(`SQLite page is empty for ${table.name}`);
		lastKey = getKeyValues(table, lastRow);
	}
	const targetCount = await countTarget(client, table.name);
	if (targetCount !== sourceRows)
		throw new Error(`Row count reconciliation failed for ${table.name}`);
	await scanPostgresTable(client, table, (row) =>
		targetMac
			.update(normalizedRowForMac(table, normalizePostgresRow(table, row)))
			.update("\n"),
	);
	if (sourceMac.digest("hex") !== targetMac.digest("hex"))
		throw new Error(`Content reconciliation failed for ${table.name}`);
}

async function copyFormLimits(client: Client, source: Database) {
	const rows = source
		.query<Row, []>(
			"SELECT id, max_published, max_monthly_responses, max_retained_responses FROM form_limits ORDER BY id",
		)
		.all();
	const base = rows.find((row) => Number(row.id) === 1);
	if (!base) throw new Error("SQLite snapshot is missing form_limits id 1");
	await client.query(
		"UPDATE public.form_limits SET max_published = $1, max_monthly_responses = $2, max_retained_responses = $3 WHERE id = 1",
		[
			base.max_published,
			base.max_monthly_responses,
			base.max_retained_responses,
		],
	);
	for (const row of rows)
		if (Number(row.id) !== 1) {
			await client.query(
				"INSERT INTO public.form_limits (id, max_published, max_monthly_responses, max_retained_responses) VALUES ($1, $2, $3, $4)",
				[
					row.id,
					row.max_published,
					row.max_monthly_responses,
					row.max_retained_responses,
				],
			);
		}
}

async function reconcileTarget(
	client: Client,
	source: Database,
	macKey: Uint8Array,
) {
	const report: Record<string, TableSummary & { contentMatches: boolean }> = {};
	for (const table of sqliteImportTables) {
		const sourceSummary = summarizeSQLiteTable(source, table);
		const targetCount = await countTarget(client, table.name);
		const sourceMac = createHmac("sha256", macKey);
		const targetMac = createHmac("sha256", macKey);
		for (const row of readAllSQLitePages(source, table))
			sourceMac
				.update(normalizedRowForMac(table, normalizeSQLiteRow(table, row)))
				.update("\n");
		await scanPostgresTable(client, table, (row) =>
			targetMac
				.update(normalizedRowForMac(table, normalizePostgresRow(table, row)))
				.update("\n"),
		);
		const contentMatches = sourceMac.digest("hex") === targetMac.digest("hex");
		if (targetCount !== sourceSummary.rows || !contentMatches)
			throw new Error(`Final reconciliation failed for ${table.name}`);
		report[table.name] = { ...sourceSummary, contentMatches };
	}
	return report;
}

async function verifyForeignKeys(client: Client) {
	const result = await client.query<{
		table_name: string;
		constraint_name: string;
	}>(`
		SELECT source.relname AS table_name, constraint_info.conname AS constraint_name
		FROM pg_catalog.pg_constraint AS constraint_info
		JOIN pg_catalog.pg_class AS source ON source.oid = constraint_info.conrelid
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = source.relnamespace
		WHERE constraint_info.contype = 'f' AND namespace.nspname = 'public'
		AND NOT constraint_info.convalidated
		LIMIT 1`);
	if (result.rows.length)
		throw new Error("PostgreSQL contains an unvalidated foreign key");
}

function validateSQLiteTable(database: Database, table: TableSpec) {
	const columns = database
		.query<{ name: string }, []>(
			`PRAGMA table_info(${quoteSqlite(table.name)})`,
		)
		.all()
		.map((column) => column.name);
	if (
		columns.length !== table.columns.length ||
		table.columns.some((column) => !columns.includes(column))
	)
		throw new Error(
			`SQLite snapshot schema does not match expected ${table.name} layout`,
		);
}

function summarizeSQLiteTable(
	database: Database,
	table: TableSpec,
): TableSummary {
	let rows = 0;
	const hash = createHash("sha256");
	for (const row of readAllSQLitePages(database, table)) {
		rows += 1;
		hash.update(JSON.stringify(getKeyValues(table, row))).update("\n");
	}
	return { rows, keyChecksum: hash.digest("hex") };
}

function* readAllSQLitePages(database: Database, table: TableSpec) {
	let lastKey: SQLQueryBindings[] | undefined;
	for (;;) {
		const rows = readSQLitePage(database, table, lastKey);
		if (!rows.length) return;
		yield* rows;
		const lastRow = rows.at(-1);
		if (!lastRow) return;
		lastKey = getKeyValues(table, lastRow);
	}
}

function readSQLitePage(
	database: Database,
	table: TableSpec,
	lastKey?: SQLQueryBindings[],
): Row[] {
	const columns = table.columns.map(quoteSqlite).join(", ");
	const order = table.key.map(quoteSqlite).join(", ");
	const predicate = lastKey
		? `WHERE (${order}) > (${table.key.map(() => "?").join(", ")})`
		: "";
	return database
		.query<Row, SQLQueryBindings[]>(
			`SELECT ${columns} FROM ${quoteSqlite(table.name)} ${predicate} ORDER BY ${order} LIMIT ?`,
		)
		.all(...(lastKey ?? []), pageSize);
}

async function insertRows(client: Client, table: TableSpec, rows: Row[]) {
	if (!rows.length) return;
	const rowsPerBatch = Math.floor(pgParameterLimit / table.columns.length);
	for (let offset = 0; offset < rows.length; offset += rowsPerBatch) {
		const batch = rows.slice(offset, offset + rowsPerBatch);
		const values: unknown[] = [];
		const tuples = batch.map((row, rowIndex) => {
			const placeholders = table.columns.map((column, columnIndex) => {
				values.push(row[column]);
				return `$${rowIndex * table.columns.length + columnIndex + 1}`;
			});
			return `(${placeholders.join(", ")})`;
		});
		await client.query(
			`INSERT INTO public.${quotePg(table.name)} (${table.columns.map(quotePg).join(", ")}) VALUES ${tuples.join(", ")}`,
			values,
		);
	}
}

async function scanPostgresTable(
	client: Client,
	table: TableSpec,
	visit: (row: Row) => void,
) {
	let lastKey: unknown[] | undefined;
	for (;;) {
		const columns = table.columns.map(quotePg).join(", ");
		const order = pgKeyExpressions(table).join(", ");
		const rightTuple = table.key.map((_, i) =>
			table.name === "form_limits"
				? `$${i + 1}`
				: `$${i + 1}::text COLLATE "C"`,
		);
		const predicate = lastKey
			? `WHERE (${order}) > (${rightTuple.join(", ")})`
			: "";
		const result = await client.query<QueryResultRow>(
			`SELECT ${columns} FROM public.${quotePg(table.name)} ${predicate} ORDER BY ${order} LIMIT ${pageSize}`,
			lastKey,
		);
		if (!result.rows.length) return;
		for (const row of result.rows) visit(row);
		lastKey = getKeyValues(table, result.rows.at(-1) as Row);
	}
}

async function countTarget(client: Client, table: string) {
	const result = await client.query<{ count: string }>(
		`SELECT count(*)::text AS count FROM public.${quotePg(table)}`,
	);
	return Number(result.rows[0]?.count ?? 0);
}

function normalizePostgresRow(table: TableSpec, source: Row): Row {
	const row: Row = {};
	for (const column of table.columns) {
		const value = source[column];
		if (pgTimeColumns.has(`${table.name}.${column}`)) {
			if (value === null || value === undefined) row[column] = null;
			else {
				const date = value instanceof Date ? value : new Date(String(value));
				if (!Number.isFinite(date.getTime()))
					throw new Error("PostgreSQL timestamp is invalid");
				row[column] = date;
			}
		} else if (
			(table.numberColumns ?? []).includes(column) &&
			value !== null &&
			value !== undefined
		) {
			const number = Number(value);
			if (!Number.isSafeInteger(number))
				throw new Error("PostgreSQL integer is outside supported range");
			row[column] = number;
		} else {
			row[column] = value;
		}
	}
	return row;
}

function pgKeyExpressions(table: TableSpec) {
	return table.key.map((column) =>
		table.name === "form_limits"
			? quotePg(column)
			: `${quotePg(column)} COLLATE "C"`,
	);
}

function getKeyValues(table: TableSpec, row: Row): SQLQueryBindings[] {
	return table.key.map((column) => {
		const value = row[column];
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "bigint"
		)
			return value;
		throw new Error(`Unsupported primary-key value in ${table.name}`);
	});
}

function quoteSqlite(value: string) {
	return `"${value.replaceAll('"', '""')}"`;
}

function quotePg(value: string) {
	return `"${value.replaceAll('"', '""')}"`;
}

function printReport(report: unknown) {
	console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
	runCli(process.argv.slice(2)).catch((error: unknown) => {
		const code =
			error &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string"
				? error.code
				: "IMPORT_FAILED";
		console.error(
			`SQLite import refused or rolled back (${code}). No row data or connection details were logged.`,
		);
		process.exitCode = 1;
	});
}
