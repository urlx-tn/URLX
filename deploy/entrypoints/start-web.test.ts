import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWebCommand, startUrlxWeb } from "./start-web.ts";

describe("web runtime launcher", () => {
	test("returns the app command exit status", async () => {
		const exitCode = await runWebCommand([
			process.execPath,
			"-e",
			"process.exit(23)",
		]);

		expect(exitCode).toBe(23);
	});

	test("fails closed before spawning the app when the policy check rejects", async () => {
		const testDir = await mkdtemp(join(tmpdir(), "urlx-web-gate-"));
		const markerPath = join(testDir, "app-started");
		const script = `await Bun.write(${JSON.stringify(markerPath)}, "started")`;

		try {
			await expect(
				startUrlxWeb([process.execPath, "-e", script], async () => {
					throw new Error("synthetic invalid policy manifest");
				}),
			).rejects.toThrow("synthetic invalid policy manifest");
			expect(await Bun.file(markerPath).exists()).toBe(false);
		} finally {
			await rm(testDir, { force: true, recursive: true });
		}
	});

	test("runs the command and arguments supplied by the container command override", async () => {
		const testDir = await mkdtemp(join(tmpdir(), "urlx-web-command-"));
		const markerPath = join(testDir, "command-argument");
		const script = `await Bun.write(${JSON.stringify(markerPath)}, process.argv.at(-1) ?? "")`;

		try {
			const exitCode = await startUrlxWeb(
				[process.execPath, "-e", script, "compose-command-override"],
				async () => {},
			);

			expect(exitCode).toBe(0);
			expect(await Bun.file(markerPath).text()).toBe(
				"compose-command-override",
			);
		} finally {
			await rm(testDir, { force: true, recursive: true });
		}
	});

	test("does not run the app command when the entrypoint gate configuration is missing", async () => {
		const testDir = await mkdtemp(join(tmpdir(), "urlx-web-entrypoint-"));
		const markerPath = join(testDir, "app-started");
		const script = `await Bun.write(${JSON.stringify(markerPath)}, "started")`;
		const launcherPath = fileURLToPath(
			new URL("./start-web.ts", import.meta.url),
		);

		try {
			const launcher = Bun.spawn(
				[process.execPath, launcherPath, process.execPath, "-e", script],
				{
					env: { ...process.env, EGRESS_POLICY_READY_FILE: "" },
					stderr: "pipe",
					stdout: "ignore",
				},
			);

			const stderr = launcher.stderr.text();
			expect(await launcher.exited).toBe(1);
			expect(await stderr).toContain(
				"EGRESS_POLICY_READY_FILE is required before web startup",
			);
			expect(await Bun.file(markerPath).exists()).toBe(false);
		} finally {
			await rm(testDir, { force: true, recursive: true });
		}
	});

	test("forwards SIGTERM to the app and returns its exit status", async () => {
		const exitCodePromise = runWebCommand([
			process.execPath,
			"-e",
			"process.on('SIGTERM', () => process.exit(17)); setInterval(() => {}, 1000)",
		]);

		setTimeout(() => process.emit("SIGTERM"), 100);

		// Windows terminates a subprocess for SIGTERM instead of delivering it
		// to the child's JavaScript signal handler.
		expect(await exitCodePromise).toBe(process.platform === "win32" ? 143 : 17);
	});

	test("forwards a stop signal received while spawning the app", async () => {
		let forwardedSignal: string | undefined;
		const fakeChild = {
			killed: false,
			signalCode: null,
			exited: Promise.resolve(0),
			kill: (signal: string) => {
				forwardedSignal = signal;
			},
		} as unknown as ReturnType<typeof Bun.spawn>;
		const spawnCommand = (() => {
			process.emit("SIGTERM");
			return fakeChild;
		}) as unknown as typeof Bun.spawn;

		const exitCode = await runWebCommand(["unused"], spawnCommand);

		expect(forwardedSignal).toBe("SIGTERM");
		expect(exitCode).toBe(0);
	});
});
