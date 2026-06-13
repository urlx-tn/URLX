import alchemy from "alchemy";
import { Astro, D1Database, Worker } from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/web/.env" });
config({ path: "../../apps/server/.env" });

const app = await alchemy("urlx");

function requireValue(name: string, value: string | undefined) {
	if (!value) {
		throw new Error(`${name} is required`);
	}

	return value;
}

const db = await D1Database("database", {
	migrationsDir: "../../packages/db/src/migrations",
});

export const server = await Worker("server", {
	cwd: "../../apps/server",
	entrypoint: "src/index.ts",
	compatibility: "node",
	url: true,
	bindings: {
		DB: db,
		CORS_ORIGIN: requireValue("CORS_ORIGIN", alchemy.env.CORS_ORIGIN),
		SHORT_URL_BASE: alchemy.env.SHORT_URL_BASE ?? "http://localhost:3000",
	},
	dev: {
		port: 3000,
	},
});

const publicServerUrl = requireValue("server URL", server.url);

export const web = await Astro("web", {
	cwd: "../../apps/web",
	entrypoint: "dist/server/entry.mjs",
	assets: "dist/client",
	bindings: {
		PUBLIC_SERVER_URL: publicServerUrl,
	},
});

console.log(`Web    -> ${web.url}`);
console.log(`Server -> ${server.url}`);

await app.finalize();
