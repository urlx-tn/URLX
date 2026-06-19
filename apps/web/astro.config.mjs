import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import node from "@astrojs/node";
import sitemap from "@astrojs/sitemap";
// @ts-check
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/astro";
import { defineConfig, envField, svgoOptimizer } from "astro/config";

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
	devToolbar: { enabled: false },
	adapter: shouldUseAlchemy
		? alchemy({ platformProxy: { configPath: alchemyConfigPath } })
		: node({ mode: "standalone" }),
	integrations: [
		sitemap({
			filter: (page) => {
				const pathname = new URL(page).pathname.replace(/\/$/, "") || "/";
				return ![
					"/404",
					"/500",
					"/tools",
					"/tools/link-in-bio/search",
				].includes(pathname);
			},
		}),
	],
	env: {
		schema: {
			PUBLIC_CONVERSION_SERVER_URL: envField.string({
				access: "public",
				context: "client",
				default: "http://localhost:3001",
			}),
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
