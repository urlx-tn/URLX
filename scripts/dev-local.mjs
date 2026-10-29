import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	access,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localData = path.join(
	process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
	"URLX-local-preview",
);
const previewRun = path.join(
	localData,
	"runs",
	`run-${randomBytes(16).toString("hex")}`,
);
const pgData = path.join(localData, "postgresql-utf8");
const pgPort = 5433;
const webPort = 4321;
const apiPort = 8787;
const children = new Set();
let postgresStarted = false;
let shuttingDown = false;

function run(executable, args, options = {}) {
	return new Promise((resolve, reject) => {
		let output = "";
		const child = spawn(executable, args, {
			cwd: options.cwd ?? root,
			env: options.env ?? process.env,
			stdio: options.stdio ?? "inherit",
			shell: false,
		});
		if (options.capture)
			child.stdout.setEncoding("utf8").on("data", (chunk) => {
				output += chunk;
			});
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0
				? resolve(output)
				: reject(new Error(`${path.basename(executable)} exited with ${code}`)),
		);
	});
}

function start(executable, args, env, cwd = root) {
	const child = spawn(executable, args, {
		cwd,
		env,
		stdio: "inherit",
		shell: false,
	});
	children.add(child);
	child.once("exit", (code) => {
		children.delete(child);
		if (!shuttingDown && code !== 0) {
			console.error(
				`${path.basename(executable)} exited unexpectedly (${code})`,
			);
			void shutdown(1);
		}
	});
	return child;
}

function randomSecret() {
	return randomBytes(32).toString("hex");
}

async function ensurePrivateDirectory(directory) {
	await mkdir(directory, { recursive: true });
	if (process.platform === "win32") {
		const whoami = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
			stdio: ["ignore", "pipe", "ignore"],
			capture: true,
		});
		const sid = whoami.match(/S-1-\d+(?:-\d+)+/)?.[0];
		if (!sid)
			throw new Error(
				"Unable to determine current Windows user SID for private local preview data",
			);
		await run("icacls.exe", [
			directory,
			"/inheritance:r",
			"/grant:r",
			`*${sid}:(OI)(CI)F`,
		]);
	}
}

async function findPostgresBin() {
	const candidates = [
		process.env.URLX_PG_BIN,
		"C:\\Program Files\\PostgreSQL\\18\\bin",
	].filter(Boolean);
	for (const candidate of candidates) {
		const bin = path.resolve(candidate);
		try {
			await Promise.all(
				["initdb.exe", "pg_ctl.exe", "psql.exe", "createdb.exe"].map((name) =>
					access(path.join(bin, name)),
				),
			);
			return bin;
		} catch {}
	}
	throw new Error(
		"PostgreSQL 18 client/server binaries not found. Set URLX_PG_BIN to their bin directory.",
	);
}

function portAvailable(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
	});
}

async function waitForPostgres(pgBin, adminPassword) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			await run(
				path.join(pgBin, "psql.exe"),
				[
					"-X",
					"-v",
					"ON_ERROR_STOP=1",
					"-h",
					"127.0.0.1",
					"-p",
					String(pgPort),
					"-U",
					"urlx_local_admin",
					"-d",
					"postgres",
					"-c",
					"SELECT 1",
				],
				{
					env: { ...process.env, PGPASSWORD: adminPassword },
					stdio: "ignore",
				},
			);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	}
	throw new Error(
		"Private local PostgreSQL did not become ready on 127.0.0.1:5433",
	);
}

async function setupPostgres(pgBin) {
	await ensurePrivateDirectory(localData);
	await ensurePrivateDirectory(previewRun);
	let adminPassword;
	const adminPasswordPath = path.join(localData, "postgres-admin-password");
	try {
		adminPassword = (await readFile(adminPasswordPath, "utf8")).trim();
	} catch {
		adminPassword = randomSecret();
		await writeFile(adminPasswordPath, `${adminPassword}\n`, {
			mode: 0o600,
			flag: "wx",
		});
	}

	const markerPath = path.join(localData, "postgresql-utf8-owner");
	try {
		const marker = await readFile(markerPath, "utf8");
		if (marker !== "URLX local preview PostgreSQL cluster v1\n")
			throw new Error(
				"Local PostgreSQL ownership marker is invalid; refusing to use this data directory",
			);
		await access(path.join(pgData, "PG_VERSION"));
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		let contents = [];
		try {
			contents = await readdir(pgData);
		} catch (readError) {
			if (readError?.code !== "ENOENT") throw readError;
		}
		if (contents.length)
			throw new Error(
				"PostgreSQL data directory exists without the URLX ownership marker; refusing to modify it",
			);
		await mkdir(pgData, { recursive: true });
		const pwFile = path.join(localData, "postgres-initdb-password");
		await writeFile(pwFile, `${adminPassword}\n`, { mode: 0o600, flag: "w" });
		try {
			await run(path.join(pgBin, "initdb.exe"), [
				"-D",
				pgData,
				"-U",
				"urlx_local_admin",
				"--encoding=UTF8",
				"--locale=C",
				"--auth-local=scram-sha-256",
				"--auth-host=scram-sha-256",
				"--pwfile",
				pwFile,
			]);
			await writeFile(
				markerPath,
				"URLX local preview PostgreSQL cluster v1\n",
				{ mode: 0o600, flag: "wx" },
			);
		} finally {
			await import("node:fs/promises").then(({ rm }) =>
				rm(pwFile, { force: true }),
			);
		}
	}

	if (!(await portAvailable(pgPort)))
		throw new Error(
			"127.0.0.1:5433 is already in use; stopping to avoid touching another PostgreSQL instance",
		);
	const pgCtl = path.join(pgBin, "pg_ctl.exe");
	await run(pgCtl, [
		"-D",
		pgData,
		"-l",
		path.join(localData, "postgresql.log"),
		"-o",
		`-h 127.0.0.1 -p ${pgPort}`,
		"start",
	]);
	postgresStarted = true;
	await waitForPostgres(pgBin, adminPassword);
	const adminEnv = { ...process.env, PGPASSWORD: adminPassword };
	const psql = path.join(pgBin, "psql.exe");
	const databaseExists = await run(
		psql,
		[
			"-X",
			"-tA",
			"-h",
			"127.0.0.1",
			"-p",
			String(pgPort),
			"-U",
			"urlx_local_admin",
			"-d",
			"postgres",
			"-c",
			"SELECT 1 FROM pg_database WHERE datname = 'urlx_local'",
		],
		{ env: adminEnv, stdio: ["ignore", "pipe", "ignore"], capture: true },
	);
	if (!databaseExists.trim())
		await run(
			path.join(pgBin, "createdb.exe"),
			[
				"-h",
				"127.0.0.1",
				"-p",
				String(pgPort),
				"-U",
				"urlx_local_admin",
				"urlx_local",
			],
			{ env: adminEnv },
		);
	const appPassword = randomSecret();
	const migratorPassword = randomSecret();
	await run(
		psql,
		[
			"-X",
			"-v",
			"ON_ERROR_STOP=1",
			"-h",
			"127.0.0.1",
			"-p",
			String(pgPort),
			"-U",
			"urlx_local_admin",
			"-d",
			"urlx_local",
			"-f",
			path.join(root, "deploy", "postgres", "roles.sql"),
		],
		{
			env: {
				...adminEnv,
				URLX_APP_PASSWORD: appPassword,
				URLX_MIGRATOR_PASSWORD: migratorPassword,
			},
		},
	);
	return {
		appPassword,
		migratorPassword,
		adminPassword,
		pgCtl,
	};
}

async function waitForHttp(url, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`Local preview did not become ready: ${url}`);
}

async function requireFreePort(port) {
	if (!(await portAvailable(port)))
		throw new Error(
			`127.0.0.1:${port} is already in use; stopping without touching that process`,
		);
}

async function shutdown(exitCode = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	let finalExitCode = exitCode;
	for (const child of children) child.kill("SIGTERM");
	await Promise.all(
		[...children].map(
			(child) => new Promise((resolve) => child.once("exit", resolve)),
		),
	);
	if (postgresStarted) {
		try {
			await run(path.join(pgBin, "pg_ctl.exe"), [
				"-D",
				pgData,
				"-m",
				"fast",
				"-w",
				"stop",
			]);
		} catch (error) {
			console.error(
				`Could not stop owned local PostgreSQL cluster: ${error.message}`,
			);
			finalExitCode = 1;
		}
		postgresStarted = false;
	}
	await rm(previewRun, { recursive: true, force: true }).catch(() => undefined);
	process.exit(finalExitCode);
}

let pgBin;
process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
	await requireFreePort(apiPort);
	await requireFreePort(webPort);
	pgBin = await findPostgresBin();
	const pg = await setupPostgres(pgBin);
	const databaseUrl = `postgresql://urlx_app:${pg.appPassword}@127.0.0.1:${pgPort}/urlx_local`;
	const migratorUrl = `postgresql://urlx_migrator:${pg.migratorPassword}@127.0.0.1:${pgPort}/urlx_local`;
	const privateEnv = {
		...process.env,
		NODE_ENV: "development",
		URLX_LOCAL_PREVIEW: "true",
		DATABASE_URL: databaseUrl,
		MIGRATOR_DATABASE_URL: migratorUrl,
	};
	await run("bun", ["packages/db/scripts/migrate.ts"], { env: privateEnv });
	const apiEnv = {
		...privateEnv,
		PORT: String(apiPort),
		URLX_LOCAL_PREVIEW_KEY: randomSecret(),
		URLX_LOCAL_AUTH_SECRET: randomSecret(),
		URLX_LOCAL_PREVIEW_DIR: previewRun,
		LOCALAPPDATA:
			process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
		URLX_LOCAL_WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
	};
	const api = start("bun", ["apps/server/src/main-local-api.ts"], apiEnv);
	await waitForHttp(`http://127.0.0.1:${apiPort}/healthz`);
	const webEnv = {
		...process.env,
		NODE_ENV: "development",
		PUBLIC_SERVER_URL: `http://127.0.0.1:${apiPort}`,
		INTERNAL_SERVER_URL: `http://127.0.0.1:${apiPort}`,
		PUBLIC_CONVERSION_SERVER_URL: "http://127.0.0.1:8788",
		PUBLIC_ORIGIN: `http://127.0.0.1:${webPort}`,
		FORMS_ENABLED: "true",
	};
	const astro = path.join(
		root,
		"apps",
		"web",
		"node_modules",
		"astro",
		"bin",
		"astro.mjs",
	);
	const web = start(
		process.execPath,
		[astro, "dev", "--host", "127.0.0.1", "--port", String(webPort)],
		webEnv,
		path.join(root, "apps", "web"),
	);
	await waitForHttp(`http://127.0.0.1:${webPort}/`);
	console.info(`URLX local preview ready: http://127.0.0.1:${webPort}`);
	console.info(
		"API: http://127.0.0.1:8787 | PostgreSQL: isolated urlx_local on 127.0.0.1:5433",
	);
	console.info("Synthetic sign-in email: local-preview@example.invalid");
	console.info(
		`Magic-link capture: ${path.join(previewRun, "magic-link.json")}`,
	);
	console.info(
		"Metadata fetch and conversion are disabled in native local preview; production Valkey/nftables startup is unchanged.",
	);
	await new Promise((resolve) => {
		api.once("exit", resolve);
		web.once("exit", resolve);
	});
	await shutdown(0);
} catch (error) {
	console.error(`Local preview failed: ${error.message}`);
	await shutdown(1);
}
