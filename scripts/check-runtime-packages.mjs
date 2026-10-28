import { access, readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const target = process.argv[2];
if (!target || process.argv.length !== 3) {
	console.error("Usage: node check-runtime-packages.mjs <production-deploy-root>");
	process.exit(2);
}

const deployRoot = resolve(target);
const storeRoot = join(deployRoot, "node_modules", ".pnpm");
try {
	await access(storeRoot);
} catch {
	console.error(`Runtime package guard: missing pnpm virtual store: ${storeRoot}`);
	process.exit(2);
}

const blockedExact = new Set([
	"@astrojs/check",
	"@astrojs/compiler",
	"@astrojs/node",
	"@astrojs/sitemap",
	"@tailwindcss/vite",
	"astro",
	"astro-loading-indicator",
	"drizzle-kit",
	"esbuild",
	"vite",
	"vitefu",
	"vitest",
]);
function isBlocked(name) {
	return blockedExact.has(name)
		|| name.startsWith("@esbuild/")
		|| name.startsWith("@esbuild-kit/")
		|| name.startsWith("@vitest/");
}

const findings = new Set();
let manifestsRead = 0;
async function inspectPackage(packageRoot) {
	const manifestPath = join(packageRoot, "package.json");
	let manifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`cannot read valid package manifest ${manifestPath}: ${error.message}`);
	}
	if (
		typeof manifest.name !== "string"
		|| !manifest.name
		|| (manifest.version !== undefined && typeof manifest.version !== "string")
	) {
		throw new Error(`invalid package manifest identity: ${manifestPath}`);
	}
	manifestsRead++;
	if (isBlocked(manifest.name)) findings.add(`${manifest.name}@${manifest.version ?? "unknown"}`);
}

try {
	for (const entry of await readdir(storeRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name === "node_modules") continue;
		const packageLinks = join(storeRoot, entry.name, "node_modules");
		let children;
		try {
			children = await readdir(packageLinks, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") {
				throw new Error(`missing package link directory: ${packageLinks}`);
			}
			throw error;
		}
		for (const child of children) {
			if (child.name.startsWith("@")) {
				const scopePath = join(packageLinks, child.name);
				const scoped = await readdir(scopePath, { withFileTypes: true });
				for (const item of scoped) {
					if (item.isDirectory() || item.isSymbolicLink()) {
						await inspectPackage(join(scopePath, item.name));
					}
				}
			} else if (child.isDirectory() || child.isSymbolicLink()) {
				await inspectPackage(join(packageLinks, child.name));
			}
		}
	}
} catch (error) {
	console.error(`Runtime package guard could not inspect ${deployRoot}: ${error.message}`);
	process.exit(2);
}

if (!manifestsRead) {
	console.error(`Runtime package guard found no package manifests in ${storeRoot}`);
	process.exit(2);
}
if (findings.size) {
	console.error(`Runtime package guard failed for ${deployRoot}: forbidden packages found:`);
	for (const name of [...findings].sort()) console.error(`- ${name}`);
	process.exit(1);
}
console.log(`Runtime package guard passed: inspected ${manifestsRead} package manifests in ${deployRoot}`);
