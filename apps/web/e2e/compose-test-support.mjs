import { spawnSync } from "node:child_process";

const projectPattern =
	/^urlx-(?:container-validation|e2e-[a-z0-9][a-z0-9_-]{0,32})$/;

export function requireComposeTestTarget() {
	const project = process.env.URLX_COMPOSE_PROJECT ?? "";
	const rawBaseUrl = process.env.URLX_FORMS_E2E_BASE_URL ?? "";
	if (!projectPattern.test(project) || !project.startsWith("urlx-")) {
		throw new Error(
			"Set URLX_COMPOSE_PROJECT to urlx-container-validation or a unique urlx-e2e-* test project name.",
		);
	}
	let baseUrl;
	try {
		baseUrl = new URL(rawBaseUrl);
	} catch {
		throw new Error("Set URLX_FORMS_E2E_BASE_URL to the isolated test origin.");
	}
	if (
		!/^https?:$/.test(baseUrl.protocol) ||
		baseUrl.username ||
		baseUrl.password ||
		baseUrl.pathname !== "/" ||
		baseUrl.search ||
		baseUrl.hash ||
		(!isLoopback(baseUrl.hostname) && !baseUrl.hostname.endsWith(".test"))
	) {
		throw new Error(
			"The Forms E2E target must be loopback or a .test host and contain no credentials/path.",
		);
	}
	return { project, origin: baseUrl.origin };
}

export function composeMagicLink(email, project, repoRoot) {
	const encodedEmail = Buffer.from(email, "utf8").toString("base64");
	const source = `
import Redis from "ioredis";
import { createFormsAuth } from "@urlx/api/modules/forms/auth";
import { createPgDb, createPgPool } from "@urlx/db";
import { createValkeyAuthStorage } from "./src/lib/valkey-auth-storage.ts";

const email = Buffer.from(${JSON.stringify(encodedEmail)}, "base64").toString("utf8");
const pool = createPgPool(process.env.DATABASE_URL, { max: 1 });
const redis = new Redis(process.env.VALKEY_URL, { maxRetriesPerRequest: 2 });
const nativeFetch = globalThis.fetch;
let html = "";
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.resend.com") return nativeFetch(input, init);
  const message = JSON.parse(String(init?.body ?? "{}"));
  if (!Array.isArray(message.to) || !message.to.includes(email)) {
    throw new Error("Test mail recipient mismatch");
  }
  html = String(message.html ?? "");
  return Response.json({ id: "urlx-container-e2e" });
};
try {
  const auth = createFormsAuth(
    process.env,
    createPgDb(pool),
    createValkeyAuthStorage(redis, process.env.VISITOR_TOKEN_KEY_BASE64),
  );
  const base = process.env.BETTER_AUTH_URL.replace(/\\/$/, "");
  const response = await auth.handler(new Request(base + "/sign-in/magic-link", {
    method: "POST",
    headers: { origin: new URL(base).origin, "content-type": "application/json" },
    body: JSON.stringify({ email, callbackURL: "/forms" }),
  }));
  if (response.status !== 200 || !html.includes("href=")) {
    throw new Error("Could not create an isolated test magic link");
  }
  console.log(JSON.stringify({ html }));
} finally {
  globalThis.fetch = nativeFetch;
  await redis.quit().catch(() => redis.disconnect());
  await pool.end();
}
`;
	return JSON.parse(runComposeApi(project, repoRoot, source));
}

export function createComposePgTestDb(project, repoRoot) {
	function bound(sql, params) {
		return {
			query: { sql, params },
			async first(column) {
				const [{ rows }] = runComposeQueries(project, repoRoot, [
					{ sql, params },
				]);
				const row = rows[0] ?? null;
				return column && row ? row[column] : row;
			},
			async run() {
				const [{ rowCount }] = runComposeQueries(project, repoRoot, [
					{ sql, params },
				]);
				return { success: true, meta: { changes: rowCount } };
			},
		};
	}
	return {
		prepare(sql) {
			return { bind: (...params) => bound(sql, params) };
		},
		batch(statements) {
			return runComposeQueries(
				project,
				repoRoot,
				statements.map((statement) => statement.query),
			);
		},
	};
}

export function cleanupComposeAccount(email, project, repoRoot) {
	if (!/^browser-\d+-[a-f0-9]{6}@example\.invalid$/.test(email)) {
		throw new Error("Refusing cleanup for a non-synthetic E2E account");
	}
	const encodedEmail = Buffer.from(email, "utf8").toString("base64");
	const sql = `BEGIN;
DO $urlx_e2e_cleanup$
DECLARE
  test_email text := convert_from(decode('${encodedEmail}', 'base64'), 'UTF8');
  test_aliases text[];
BEGIN
  IF test_email NOT LIKE 'browser-%@example.invalid' THEN
    RAISE EXCEPTION 'synthetic account guard failed';
  END IF;
  SELECT array_agg(a.alias) INTO test_aliases
  FROM public.form_aliases AS a
  JOIN public.forms AS f ON f.id = a.form_id
  JOIN public."user" AS u ON u.id = f.owner_id
  WHERE u.email = test_email;
  DELETE FROM public.links
  WHERE short_code IN (
    SELECT f.short_code
    FROM public.forms AS f
    JOIN public."user" AS u ON u.id = f.owner_id
    WHERE u.email = test_email
  );
  DELETE FROM public."user" WHERE email = test_email;
  DELETE FROM public.form_alias_tombstones
  WHERE alias = ANY(COALESCE(test_aliases, ARRAY[]::text[]));
  DELETE FROM public.form_alias_locks
  WHERE alias = ANY(COALESCE(test_aliases, ARRAY[]::text[]));
END
$urlx_e2e_cleanup$;
COMMIT;
\\echo cleanup-ok
`;
	const result = runComposePostgresCleanup(project, repoRoot, sql);
	if (!result.endsWith("cleanup-ok"))
		throw new Error("E2E cleanup did not complete");
}

function runComposeApi(project, repoRoot, source, input = "") {
	const sshTarget = process.env.URLX_FORMS_E2E_SSH_TARGET;
	let executable = "docker";
	let args = [
		"compose",
		"--project-name",
		project,
		"--file",
		"compose.yaml",
		"exec",
		"-T",
		"api",
		"bun",
		"-e",
		source,
	];
	if (sshTarget) {
		const remoteRoot = process.env.URLX_FORMS_E2E_REMOTE_REPO ?? "";
		if (
			!/^[A-Za-z0-9_.@:-]+$/.test(sshTarget) ||
			sshTarget.startsWith("-") ||
			!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(remoteRoot) ||
			remoteRoot.split("/").includes("..")
		) {
			throw new Error(
				"Set URLX_FORMS_E2E_SSH_TARGET and an absolute safe URLX_FORMS_E2E_REMOTE_REPO path.",
			);
		}
		const encodedSource = Buffer.from(source, "utf8").toString("base64");
		const remoteCommand = `cd ${remoteRoot} && docker compose --project-name ${project} --file compose.yaml exec -T api bun -e "$(printf '%s' '${encodedSource}' | base64 -d)"`;
		executable = "ssh";
		args = ["-T", sshTarget, remoteCommand];
	}
	const result = spawnSync(executable, args, {
		cwd: repoRoot,
		input,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
		env: process.env,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`The isolated API-container E2E helper failed (exit ${result.status ?? "unknown"}). Check the private test stack and Compose project.`,
		);
	}
	return result.stdout.trim();
}

function runComposeQueries(project, repoRoot, queries) {
	const source = `
import { createPgPool } from "@urlx/db";
const queries = JSON.parse(await new Response(Bun.stdin.stream()).text());
const pool = createPgPool(process.env.DATABASE_URL, { max: 1 });
try {
  await pool.query("BEGIN");
  const results = [];
  for (const query of queries) {
    let placeholder = 0;
    const sql = query.sql.replace(/\\?/g, () => "$" + (++placeholder));
    const result = await pool.query(sql, query.params);
    results.push({ rows: result.rows, rowCount: result.rowCount });
  }
  await pool.query("COMMIT");
  console.log(JSON.stringify(results));
} catch (error) {
  await pool.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
`;
	return JSON.parse(
		runComposeApi(project, repoRoot, source, JSON.stringify(queries)),
	);
}

function runComposePostgresCleanup(project, repoRoot, sql) {
	const args = [
		"compose",
		"--project-name",
		project,
		"--file",
		"compose.yaml",
		"exec",
		"-T",
		"postgres",
		"sh",
		"-c",
		'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
	];
	const sshTarget = process.env.URLX_FORMS_E2E_SSH_TARGET;
	let executable = "docker";
	let executableArgs = args;
	if (sshTarget) {
		const remoteRoot = process.env.URLX_FORMS_E2E_REMOTE_REPO ?? "";
		if (
			!/^[A-Za-z0-9_.@:-]+$/.test(sshTarget) ||
			sshTarget.startsWith("-") ||
			!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(remoteRoot) ||
			remoteRoot.split("/").includes("..")
		) {
			throw new Error(
				"Set URLX_FORMS_E2E_SSH_TARGET and an absolute safe URLX_FORMS_E2E_REMOTE_REPO path.",
			);
		}
		const remoteCommand = `cd ${remoteRoot} && docker compose --project-name ${project} --file compose.yaml exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`;
		executable = "ssh";
		executableArgs = ["-T", sshTarget, remoteCommand];
	}
	const result = spawnSync(executable, executableArgs, {
		cwd: repoRoot,
		input: sql,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
		env: process.env,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`The scoped PostgreSQL E2E cleanup failed (exit ${result.status ?? "unknown"}). Check the private test stack and Compose project.`,
		);
	}
	return result.stdout.trim();
}

function isLoopback(hostname) {
	return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}
