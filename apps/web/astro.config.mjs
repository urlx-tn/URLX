import node from "@astrojs/node";
import sitemap from "@astrojs/sitemap";
// @ts-check
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, envField, svgoOptimizer } from "astro/config";

// https://astro.build/config
export default defineConfig({
	site: "https://urlx.tn",
	output: "server",
	devToolbar: { enabled: false },
	adapter: node({ mode: "standalone" }),
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
			FORMS_ENABLED: envField.string({
				access: "secret",
				context: "server",
				default: "false",
			}),
			INTERNAL_SERVER_URL: envField.string({
				access: "secret",
				context: "server",
				optional: true,
			}),
			EGRESS_PROXY_URL: envField.string({
				access: "secret",
				context: "server",
				optional: true,
			}),
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
	},
});
