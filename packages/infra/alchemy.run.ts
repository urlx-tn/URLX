import alchemy from "alchemy";
import {
	Astro,
	BrowserRendering,
	D1Database,
	RateLimit,
	Worker,
} from "alchemy/cloudflare";
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

export const conversion = await Worker("conversion", {
	adopt: true,
	cwd: "../../apps/server",
	entrypoint: "src/conversion.ts",
	compatibility: "node",
	compatibilityDate: "2026-03-24",
	url: true,
	bindings: {
		BROWSER: BrowserRendering(),
		CONVERSION_RATE_LIMIT: RateLimit({
			namespace_id: 1001,
			simple: {
				limit: 5,
				period: 60,
			},
		}),
		CORS_ORIGIN: requireValue("CORS_ORIGIN", alchemy.env.CORS_ORIGIN),
	},
	dev: {
		remote: true,
	},
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
		METADATA_RATE_LIMIT: RateLimit({
			namespace_id: 1002,
			simple: {
				limit: 20,
				period: 60,
			},
		}),
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
		PUBLIC_CONVERSION_SERVER_URL: requireValue(
			"PUBLIC_CONVERSION_SERVER_URL",
			conversion.url,
		),
		PUBLIC_SERVER_URL: publicServerUrl,
	},
});

console.log(`Web    -> ${web.url}`);
console.log(`Server -> ${server.url}`);
console.log(`Conversion -> ${conversion.url}`);
console.log(`API    -> ${publicServerUrl}`);

await app.finalize();
