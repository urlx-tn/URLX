import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "forms-browser.mjs",
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	outputDir: "artifacts/test-results",
	use: { browserName: "chromium", headless: true },
});
