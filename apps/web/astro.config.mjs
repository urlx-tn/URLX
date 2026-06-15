import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-check
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/astro";
import sitemap from "@astrojs/sitemap";
import { defineConfig, envField, svgoOptimizer } from "astro/config";

import node from "@astrojs/node";

const alchemyConfigPath = fileURLToPath(
	new URL("./.alchemy/local/wrangler.jsonc", import.meta.url),
);
const shouldUseAlchemy = existsSync(alchemyConfigPath);
const cloudflareWorkersShimPath = fileURLToPath(
	new URL("../../packages/env/src/cloudflare-local.ts", import.meta.url),
);
const cloudflareWorkersAlias = shouldUseAlchemy
	? {}
	: {
			"cloudflare:workers": cloudflareWorkersShimPath,
		};

// https://astro.build/config
export default defineConfig({
	site: "https://www.urlx.tn",
	output: "server",
	adapter: shouldUseAlchemy
		? alchemy({ platformProxy: { configPath: alchemyConfigPath } })
		: node({ mode: "standalone" }),
	integrations: [sitemap()],
	env: {
		schema: {
			PUBLIC_SERVER_URL: envField.string({
				access: "public",
				context: "client",
				default: "http://localhost:3000",
			}),
		},
	},
	image: {
		responsiveStyles: true,
	},
	experimental: {
		svgOptimizer: svgoOptimizer(),
	},
	vite: {
		envDir: "../..",
		plugins: [tailwindcss()],
		resolve: { alias: cloudflareWorkersAlias },
	},
});
