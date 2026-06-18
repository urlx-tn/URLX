import alchemy from "alchemy";
import { Astro, D1Database, Worker } from "alchemy/cloudflare";
import { config } from "dotenv";

function getCliStage() {
	const stageIndex = process.argv.indexOf("--stage");
	const stageValue = stageIndex >= 0 ? process.argv[stageIndex + 1] : undefined;

	if (!stageValue || stageValue.startsWith("-")) {
		return undefined;
	}

	return stageValue;
}

const cliStage = getCliStage();

const stageEnvFile =
	cliStage === "prod"
		? "../../.env.production"
		: cliStage === "dev"
			? "../../.env.development"
			: cliStage
				? `../../.env.${cliStage}`
				: undefined;

if (stageEnvFile) {
	config({ path: stageEnvFile });
} else {
	config({ path: "../../.env" });
}

const app = await alchemy("urlx");

function requireValue(name: string, value: string | undefined) {
	if (!value) {
		throw new Error(`${name} is required`);
	}

	return value;
}

const db = await D1Database("database", {
	adopt: true,
	migrationsDir: "../../packages/db/src/migrations",
});

export const server = await Worker("server", {
	adopt: true,
	cwd: "../../apps/server",
	entrypoint: "src/index.ts",
	compatibility: "node",
	url: true,
	bindings: {
		DB: db,
		CORS_ORIGIN: requireValue("CORS_ORIGIN", alchemy.env.CORS_ORIGIN),
		SHORT_URL_BASE: requireValue("SHORT_URL_BASE", alchemy.env.SHORT_URL_BASE),
	},
	dev: {
		port: 3000,
	},
});

const publicServerUrl = requireValue(
	"PUBLIC_SERVER_URL",
	alchemy.env.PUBLIC_SERVER_URL,
);

export const web = await Astro("web", {
	adopt: true,
	cwd: "../../apps/web",
	entrypoint: "dist/server/entry.mjs",
	assets: "dist/client",
	bindings: {
		PUBLIC_SERVER_URL: publicServerUrl,
	},
});

console.log(`Web    -> ${web.url}`);
console.log(`Server -> ${server.url}`);
console.log(`API    -> ${publicServerUrl}`);

await app.finalize();
