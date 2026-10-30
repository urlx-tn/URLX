import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "forms-bun-postgres-browser.mjs",
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	outputDir: "artifacts/test-results-compose",
	use: {
		browserName: "chromium",
		headless: true,
		ignoreHTTPSErrors: false,
		trace: "off",
		screenshot: "off",
		video: "off",
	},
});
