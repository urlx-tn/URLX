import { spawn } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const requireFromServer = createRequire(
	resolve(root, "apps/server/package.json"),
);
const requireFromWeb = createRequire(resolve(root, "apps/web/package.json"));
const { Miniflare } = requireFromServer("miniflare");
const migrationsDirectory = resolve(root, "packages/db/src/migrations");
const migrationNames = [
	"0000_faulty_iron_patriot.sql",
	"0001_handy_shocker.sql",
	"0002_forms_auth.sql",
];
const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = `browser-${runId}@example.invalid`;
const listenHost = "127.0.0.1";
let syntheticPublicOrigin;
const forbiddenHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

let mf;
let d1;
let apiServer;
let viteServer;
let astroProcess;
let browser;
let workspace;
let astroOrigin;
let apiOrigin;
let capturedEmailHtml = "";
let originalFetch;
let astroOutput = "";

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

function availablePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, listenHost, () => {
			const address = server.address();
			server.close(() => resolvePort(address.port));
		});
	});
}

function localUrl(host, port) {
	if (!forbiddenHostnames.has(host))
		throw new Error(`Refusing non-loopback host: ${host}`);
	return `http://${host}:${port}`;
}

async function routeSyntheticPublicOrigin(context) {
	await context.route("**/*", routeSyntheticPublicRequest);
}

async function routeSyntheticPublicRequest(route) {
	const requested = new URL(route.request().url());
	if (requested.origin === syntheticPublicOrigin) {
		const localTarget = new URL(
			`${requested.pathname}${requested.search}${requested.hash}`,
			astroOrigin,
		);
		if (!forbiddenHostnames.has(localTarget.hostname))
			throw new Error(`Refusing non-loopback route target: ${localTarget.hostname}`);
		await route.continue({ url: localTarget.toString() });
		return;
	}
	if (
		requested.protocol === "http:" &&
		forbiddenHostnames.has(requested.hostname)
	) {
		await route.continue();
		return;
	}
	throw new Error(`Blocked non-loopback browser request: ${requested.origin}`);
}

async function waitForUrl(url, child, label) {
	const deadline = Date.now() + 45_000;
	let lastError;
	while (Date.now() < deadline) {
		if (child.exitCode !== null)
			throw new Error(`${label} exited early (${child.exitCode})`);
		try {
			const response = await fetch(url, { redirect: "manual" });
			if (response.status < 500) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`${label} did not become ready: ${lastError}`);
}

async function makeSanitizedWorkspace() {
	const parent = await mkdtemp(resolve(tmpdir(), "urlx-forms-e2e-"));
	workspace = resolve(parent, "URLX");
	const excluded = new Set([
		".git",
		"node_modules",
		".wrangler",
		".alchemy",
		".turbo",
		".astro",
		".vite",
		".mf",
		".dev.vars",
		"dist",
	]);
	await cp(root, workspace, {
		recursive: true,
		filter: (source) => {
			const relative = source.slice(root.length).replace(/^[/\\]/, "");
			if (!relative) return true;
			const parts = relative.split(/[\\/]/);
			if (parts.some((part) => excluded.has(part))) return false;
			if (parts.some((part) => /^\.env(?:\.|$)/i.test(part))) return false;
			return true;
		},
	});
	// Reuse already-installed, trusted workspace dependencies without copying or linking any secrets.
	await symlink(
		resolve(root, "node_modules"),
		resolve(workspace, "node_modules"),
		"junction",
	);
	for (const group of ["apps", "packages"]) {
		for (const entry of await readdir(resolve(workspace, group), {
			withFileTypes: true,
		})) {
			if (!entry.isDirectory()) continue;
			const sourceModules = resolve(root, group, entry.name, "node_modules");
			try {
				await symlink(
					sourceModules,
					resolve(workspace, group, entry.name, "node_modules"),
					"junction",
				);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
	return workspace;
}

async function startApi() {
	const servicePath = requireFromServer.resolve(
		"@urlx/api/modules/forms/forms.service",
	);
	const serviceSource = await readFile(servicePath, "utf8");
	if (!servicePath.replaceAll("\\", "/").includes("packages/api/src/modules/forms/forms.service.ts") || !serviceSource.includes("titleSlug"))
		throw new Error(`Browser API bridge resolved an unexpected FormsService source: ${servicePath}`);
	const { createServer: createViteServer } = requireFromServer("vite");
	viteServer = await createViteServer({
		root,
		configFile: false,
		server: { middlewareMode: true },
		appType: "custom",
		logLevel: "error",
		resolve: {
			alias: {
				"cloudflare:workers": resolve(
					root,
					"apps/server/tests/worker-env-mock.ts",
				),
			},
		},
	});
	const { formsApp } = await viteServer.ssrLoadModule(
		"/apps/server/src/forms.ts",
	);
	const { appRouter } = await viteServer.ssrLoadModule(
		"/packages/api/src/routers/index.ts",
	);
	const { createContext } = await viteServer.ssrLoadModule(
		"/packages/api/src/context.ts",
	);
	const { Hono } = requireFromServer("hono");
	const { RPCHandler } = requireFromServer("@orpc/server/fetch");
	const rpcHandler = new RPCHandler(appRouter);
	const serverApp = new Hono();
	serverApp.route("/", formsApp);
	serverApp.use("/*", async (c, next) => {
		const context = await createContext({ context: c });
		const result = await rpcHandler.handle(c.req.raw, {
			prefix: "/rpc",
			context,
		});
		if (result.matched)
			return c.newResponse(result.response.body, result.response);
		await next();
	});
	serverApp.get("/", (c) => c.text("OK"));
	const serverEnv = {
		FORMS_ENABLED: true,
		CORS_ORIGIN: syntheticPublicOrigin,
		SHORT_URL_BASE: syntheticPublicOrigin,
		VISITOR_TOKEN_KEY: await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(
				`synthetic-visitor-key-${runId}`.padEnd(32, "x"),
			),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		),
		BETTER_AUTH_SECRET: `synthetic-e2e-secret-${runId}-never-for-deployment`,
		BETTER_AUTH_URL: astroOrigin,
		RESEND_API_KEY: `re_test_${runId}`,
		AUTH_EMAIL_FROM: "URLX E2E <forms@example.invalid>",
		DB: d1,
	};
	const routeProbe = await serverApp.request("/api/forms", {}, serverEnv);
	if (routeProbe.status !== 401)
		throw new Error(
			`Local Forms API route probe returned ${routeProbe.status}: ${await routeProbe.text()}`,
		);
	apiServer = createServer(async (incoming, outgoing) => {
		try {
			const chunks = [];
			for await (const chunk of incoming) chunks.push(chunk);
			const requestBody = chunks.length ? Buffer.concat(chunks) : undefined;
			const request = new Request(new URL(incoming.url ?? "/", apiOrigin), {
				method: incoming.method,
				headers: incoming.headers,
				body: ["GET", "HEAD"].includes(incoming.method ?? "GET")
					? undefined
					: requestBody,
			});
			const response = await serverApp.fetch(request, serverEnv);
			const headers = Object.fromEntries(response.headers.entries());
			if (response.headers.getSetCookie)
				headers["set-cookie"] = response.headers.getSetCookie();
			outgoing.writeHead(response.status, headers);
			outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch (error) {
			outgoing.writeHead(500, { "content-type": "text/plain" });
			outgoing.end(
				error instanceof Error ? error.message : "Local test server error",
			);
		}
	});
	await new Promise((resolveListen, reject) => {
		apiServer.once("error", reject);
		apiServer.listen(new URL(apiOrigin).port, listenHost, resolveListen);
	});
}

test.beforeAll(async () => {
	if (resolve(root) !== root || basename(root) !== "URLX")
		throw new Error(
			"Unexpected repository root; refusing to start the isolated browser harness.",
		);
	const apiPort = await availablePort();
	let webPort = await availablePort();
	while (webPort === apiPort) webPort = await availablePort();
	apiOrigin = localUrl(listenHost, apiPort);
	astroOrigin = localUrl(listenHost, webPort);
	syntheticPublicOrigin = `http://forms-e2e.test:${webPort}`;

	mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('ok') } }",
		compatibilityDate: "2026-05-01",
		d1Databases: ["DB"],
	});
	d1 = await mf.getD1Database("DB");
	for (const name of migrationNames) {
		const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
		for (const statement of sql
			.split("--> statement-breakpoint")
			.map((part) => part.trim())
			.filter(Boolean))
			await d1.prepare(statement).run();
	}

	originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = new URL(
			typeof input === "string" || input instanceof URL ? input : input.url,
		);
		if (url.hostname === "api.resend.com") {
			const payload = JSON.parse(String(init?.body ?? "{}"));
			capturedEmailHtml = String(payload.html ?? "");
			return new Response(
				JSON.stringify({ id: `synthetic-message-${runId}` }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (forbiddenHostnames.has(url.hostname)) return originalFetch(input, init);
		throw new Error(
			`Blocked non-loopback network request in browser harness: ${url.origin}`,
		);
	};

	await makeSanitizedWorkspace();
	await startApi();
	const astroEntry = requireFromWeb.resolve("astro");
	const astroCli = resolve(dirname(astroEntry), "../bin/astro.mjs");
	astroProcess = spawn(
		process.execPath,
		[
			astroCli,
			"dev",
			"--host",
			listenHost,
			"--port",
			String(webPort),
			"--strictPort",
		],
		{
			cwd: resolve(workspace, "apps/web"),
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				TEMP: process.env.TEMP,
				TMP: process.env.TMP,
				FORMS_ENABLED: "true",
				PUBLIC_SERVER_URL: apiOrigin,
				PUBLIC_CONVERSION_SERVER_URL: "http://127.0.0.1:1",
			},
			stdio: "pipe",
		},
	);
	astroProcess.stdout.on("data", (chunk) => {
		astroOutput += chunk.toString();
	});
	astroProcess.stderr.on("data", (chunk) => {
		astroOutput += chunk.toString();
	});
	await waitForUrl(astroOrigin, astroProcess, "Astro dev server").catch(
		(error) => {
			throw new Error(`${error.message}\n${astroOutput}`);
		},
	);
	await waitForUrl(
		`${apiOrigin}/api/forms`,
		{ exitCode: null },
		"Local Forms API",
	);
	browser = await chromium.launch({
		headless: true,
		args: [
			"--host-resolver-rules=MAP forms-e2e.test 127.0.0.1, EXCLUDE localhost",
		],
	});
});

test.afterAll(async () => {
	await browser?.close();
	if (astroProcess && astroProcess.exitCode === null) {
		astroProcess.kill("SIGTERM");
		await new Promise((resolveExit) => {
			const timer = setTimeout(resolveExit, 4_000);
			astroProcess.once("exit", () => {
				clearTimeout(timer);
				resolveExit();
			});
		});
	}
	if (apiServer?.listening)
		await new Promise((resolveClose) => apiServer.close(resolveClose));
	await mf?.dispose();
	await viteServer?.close();
	if (originalFetch) globalThis.fetch = originalFetch;
	if (workspace) await rm(dirname(workspace), { recursive: true, force: true });
});

test("magic-link auth, editor keyboard flow, draft save, publish, response and public no-JS flow", async ({}, testInfo) => {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1100 },
		acceptDownloads: true,
	});
	context.on("request", (request) => {
		if (new URL(request.url()).hostname === "forms-e2e.test") {
			console.log(`Synthetic public request observed: ${request.url()}`);
		}
	});
	await routeSyntheticPublicOrigin(context);
	const page = await context.newPage();
	let viteFullReloads = 0;
	const cdp = await context.newCDPSession(page);
	await cdp.send("Network.enable");
	cdp.on("Network.webSocketFrameReceived", (event) => {
		const payload = event.response.payloadData;
		try { if (JSON.parse(payload).type === "full-reload") viteFullReloads++; } catch {}
	});
	const artifacts = resolve(here, "artifacts");
	await mkdir(artifacts, { recursive: true });
	await page.goto(`${astroOrigin}/forms`);
	await expect(
		page.getByRole("heading", { name: "Sign in to manage your forms" }),
	).toBeVisible();
	await page.getByLabel("Email address").fill(email);
	await page.getByRole("button", { name: "Send sign-in link" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Check your inbox" }),
	).toBeVisible();
	await expect.poll(() => capturedEmailHtml).toContain("href=");
	const link = /href="([^"]+)"/
		.exec(capturedEmailHtml)?.[1]
		?.replaceAll("&amp;", "&");
	expect(link).toBeTruthy();
	const authUrl = new URL(link);
	expect(forbiddenHostnames.has(authUrl.hostname)).toBe(true);
	await page.goto(authUrl.toString());
	await expect(page).toHaveURL(/\/forms(?:[?#].*)?$/);
	expect(
		(await context.cookies()).some(
			(cookie) => cookie.name === "urlx-forms.session_token",
		),
	).toBe(true);
	await page.goto(`${astroOrigin}/forms/e2e-dependency-warmup`);
	await expect(page.locator(".forms-app")).toHaveAttribute("data-ready", "true");
	await page.waitForTimeout(1_500);
	const warmedReloadCount = viteFullReloads;
	await page.waitForTimeout(1_000);
	expect(viteFullReloads).toBe(warmedReloadCount);
	await page.goto(`${astroOrigin}/tools/forms`);
	await page.getByRole("button", { name: "Registration" }).click();
	await expect(page).toHaveURL(/\/forms\/[^/]+$/);
	await expect(page.getByLabel("Form title")).toBeVisible();
	await expect(page.locator(".forms-app")).toHaveAttribute("data-ready", "true");
	const formId = new URL(page.url()).pathname.split("/").at(-1);
	const editedTitle = `E2E registration ${runId}`;
	const reloadCountBeforeEdit = viteFullReloads;
	await page.waitForTimeout(650);
	expect(viteFullReloads).toBe(reloadCountBeforeEdit);
	const firstDraftPut = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/draft"), { timeout: 8_000 }).catch(() => null);
	await page.getByLabel("Form title").fill(editedTitle);
	await page
		.getByLabel("Form description")
		.fill("A browser-created form from an isolated local D1 database.");
	const firstSave = await firstDraftPut;
	expect(firstSave, "Editor should autosave title and description before structural edits").toBeTruthy();
	expect(firstSave.status()).toBe(200);
	const firstPersisted = await page.request.get(`${astroOrigin}/api/forms/${encodeURIComponent(formId)}`);
	expect((await firstPersisted.json()).draft?.title).toBe(editedTitle);
	const question = page.locator(".q-label").first();
	const startingQuestionCount = await page.locator(".f-question").count();
	expect(startingQuestionCount).toBeGreaterThan(0);
	const structuralSave = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/draft"), { timeout: 8_000 }).catch(() => null);
	await question.focus();
	await page.keyboard.press("Control+d");
	await expect(page.locator(".f-question")).toHaveCount(startingQuestionCount + 1);
	await expect(page.getByLabel("Form title")).toHaveValue(editedTitle);
	await page.keyboard.press("Control+z");
	await expect(page.locator(".f-question")).toHaveCount(startingQuestionCount);
	await expect(page.getByLabel("Form title")).toHaveValue(editedTitle);
	const structuralSaved = await structuralSave;
	expect(structuralSaved, "Undo should autosave the restored draft").toBeTruthy();
	expect(structuralSaved.status()).toBe(200);
	await expect
		.poll(async () => {
			const result = await page.request.get(
				`${astroOrigin}/api/forms/${encodeURIComponent(formId)}`,
			);
			return (await result.json()).draft?.title;
		}, { timeout: 20_000 })
		.toBe(editedTitle);
	await page.screenshot({
		path: resolve(artifacts, "forms-editor-desktop.png"),
		fullPage: true,
	});

	await page.getByRole("button", { name: "Preview" }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByRole("button", { name: "Phone", exact: true }).click();
	await expect(page.locator("#preview-content")).toHaveClass(/phone/);
	await page.getByRole("button", { name: "Close preview" }).click();
	const publishResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/forms/${encodeURIComponent(formId)}/publish`), { timeout: 10_000 });
	await page.getByRole("button", { name: "Publish" }).click();
	const publishResponse = await publishResponsePromise;
	const publishBody = await publishResponse.text();
	expect(publishResponse.status(), `Publish response body: ${publishBody}`).toBe(200);
	await expect(page.getByLabel("Form link slug")).toBeVisible();
	const slugInput = page.getByLabel("Form link slug");
	const slug = `browser-${runId}`.replaceAll(/[^a-z0-9-]/g, "");
	await slugInput.fill(slug);
	const slugSaveResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/forms/${encodeURIComponent(formId)}/slug`));
	await page.getByRole("button", { name: "Save", exact: true }).click();
	const slugSaveResponse = await slugSaveResponsePromise;
	console.log("Slug save diagnostics", slugSaveResponse.status(), await slugSaveResponse.text());
	const slugOwnerRead = await page.request.get(`${astroOrigin}/api/forms/${encodeURIComponent(formId)}`);
	console.log("Slug owner GET", slugOwnerRead.status(), await slugOwnerRead.text());
	await expect(page.getByText("Published", { exact: true })).toBeVisible();
	await expect(page.getByText("Short link:")).toBeVisible();
	const publicUrl = await page.locator("#share-url").inputValue();
	await expect(page.locator("#share-qr img")).toBeVisible();
	for (const format of ["png", "svg"]) {
		const downloadPromise = page.waitForEvent("download");
		await page.locator(`#qr-${format}`).click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
		const downloadPath = resolve(artifacts, `form-qr.${format}`);
		await download.saveAs(downloadPath);
		const bytes = await readFile(downloadPath);
		if (format === "png")
			expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		else expect(bytes.toString("utf8")).toContain("<svg");
	}
	const shortLink = page.locator(".f-share-card a[href*='/u/']").first();
	const shortUrl = await shortLink.getAttribute("href");
	expect(shortUrl).toBeTruthy();
	expect(new URL(shortUrl).origin).toBe(syntheticPublicOrigin);
	const shortPage = await context.newPage();
	await shortPage.route("**/*", routeSyntheticPublicRequest);
	shortPage.on("response", async (response) => {
		if (/\/(?:u|f)\//.test(new URL(response.url()).pathname)) {
			let body = "";
			if (response.status() < 300 || response.status() >= 400)
				body = (await response.text().catch(() => "")).slice(0, 500);
			console.log("Short/public response", response.status(), response.url(), response.headers().location ?? "", body);
		}
	});
	await shortPage.goto(shortUrl);
	await expect(shortPage).toHaveURL(new RegExp(`/f/${slug}$`));
	await expect(
		shortPage.getByRole("heading", { name: `E2E registration ${runId}` }),
	).toBeVisible();

	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Responses" }).click();
	await expect(
		page.getByRole("heading", { name: "No responses yet" }),
	).toBeVisible();
	await page.screenshot({
		path: resolve(artifacts, "forms-responses-mobile.png"),
		fullPage: true,
	});
	const mobileEditor = await context.newPage();
	await mobileEditor.setViewportSize({ width: 390, height: 844 });
	await mobileEditor.goto(page.url());
	await expect(mobileEditor.locator(".f-editor-grid")).toBeVisible();
	await mobileEditor.screenshot({
		path: resolve(artifacts, "forms-editor-mobile.png"),
		fullPage: true,
	});

	const publicContext = await browser.newContext({
		javaScriptEnabled: false,
		viewport: { width: 390, height: 844 },
	});
	await routeSyntheticPublicOrigin(publicContext);
	const publicPage = await publicContext.newPage();
	await publicPage.goto(publicUrl);
	await expect(
		publicPage.getByRole("heading", { name: `E2E registration ${runId}` }),
	).toBeVisible();
	await expect(publicPage.getByLabel("Full name")).toBeVisible();
	await publicPage.getByLabel("Full name").fill("Synthetic Respondent");
	await publicPage.getByLabel("Email").fill("respondent@example.invalid");
	await publicPage.getByRole("radio", { name: "Morning" }).check();
	await publicPage.getByRole("button", { name: "Submit" }).click();
	await expect(
		publicPage.getByRole("heading", { name: "Thank you" }),
	).toBeVisible();
	await publicPage.screenshot({
		path: resolve(artifacts, "forms-public-response-mobile.png"),
		fullPage: true,
	});

	await page.getByRole("button", { name: "Build" }).click();
	await page.locator(".q-label").first().fill("Name for registration");
	await expect
		.poll(async () => {
			const response = await page.evaluate(async (id) => {
				const result = await fetch(`/api/forms/${encodeURIComponent(id)}`);
				return result.json();
			}, formId);
			return response.draft?.fields?.[0]?.label;
		}, { timeout: 20_000 })
		.toBe("Name for registration");
	await page.getByRole("button", { name: "Publish" }).click();
	await expect(page.getByLabel("Form link slug")).toBeVisible();
	const versionResponse = await page.request.get(
		`${astroOrigin}/api/forms/${encodeURIComponent(formId)}`,
	);
	expect(versionResponse.status()).toBe(200);
	const versionResult = await versionResponse.json();
	expect(versionResult.publishedVersion.fields[0].label).toBe(
		"Name for registration",
	);
	const versionCount = await d1
		.prepare("SELECT count(*) AS count FROM form_versions WHERE form_id = ?")
		.bind(formId)
		.first("count");
	expect(Number(versionCount)).toBe(2);

	await page.getByRole("button", { name: "Responses" }).click();
	await expect(
		page.getByRole("cell", { name: "Synthetic Respondent" }),
	).toBeVisible();
	await expect(page.getByText(/Version 1 · 1 response/)).toBeVisible();
	await page.screenshot({
		path: resolve(artifacts, "forms-responses-with-data.png"),
		fullPage: true,
	});
	await publicContext.close();
	await mobileEditor.close();
	await shortPage.close();
	await context.close();
	await testInfo.attach("local-run-id", {
		body: runId,
		contentType: "text/plain",
	});
});
