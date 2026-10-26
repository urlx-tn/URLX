import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"cloudflare:workers": resolve(
				dirname(fileURLToPath(import.meta.url)),
				"tests/worker-env-mock.ts",
			),
		},
	},
	test: { testTimeout: 30_000 },
});
