import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-check
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/astro";
import { defineConfig, envField } from "astro/config";
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
import node from "@astrojs/node";

// https://astro.build/config
export default defineConfig({
  output: "server",
  adapter: shouldUseAlchemy
    ? alchemy({ platformProxy: { configPath: alchemyConfigPath } })
    : node({ mode: "standalone" }),
  env: {
    schema: {
      PUBLIC_SERVER_URL: envField.string({
        access: "public",
        context: "client",
        default: "http://localhost:3000",
      }),
    },
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: { alias: cloudflareWorkersAlias },
  },
});
