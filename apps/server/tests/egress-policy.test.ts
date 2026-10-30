import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	verifyEgressPolicyReadyFile,
	waitForEgressPolicyReadyFile,
} from "@urlx/env/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const containerId = "a".repeat(64);
const networkId = "b".repeat(64);
const proxyId = "c".repeat(64);
const serviceIps = ["172.20.0.4", "172.21.0.4"];

describe("egress policy readiness gate", () => {
	let directory: string | undefined;
	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	async function writeManifest(overrides: Record<string, unknown> = {}) {
		directory = await mkdtemp(join(tmpdir(), "urlx-egress-test-"));
		const service = {
			containerId,
			netns: "net:[12345]",
			networks: serviceIps.map((ip, index) => ({
				networkId: `${index ? "d" : "b"}`.repeat(64),
				ip,
			})),
		};
		const manifest = {
			policyVersion: 1,
			verifiedAt: new Date().toISOString(),
			ruleSetHash: "e".repeat(64),
			hostAddresses: ["192.0.2.10"],
			proxy: {
				containerId: proxyId,
				networks: [{ networkId, ip: "172.20.0.2" }],
			},
			services: {
				api: service,
				conversion: service,
				"conversion-renderer": service,
				web: service,
			},
			...overrides,
		};
		const path = join(directory, "ready.json");
		await writeFile(path, JSON.stringify(manifest));
		return path;
	}

	const identity = {
		containerHostname: "a".repeat(12),
		currentNetns: "net:[12345]",
		currentIps: serviceIps,
		proxyAddresses: ["172.20.0.2"],
		checkProxy: false,
	};

	it("accepts only a fresh manifest matching this container, netns, addresses, and proxy", async () => {
		const path = await writeManifest();
		await expect(
			verifyEgressPolicyReadyFile(path, "api", {
				...identity,
				currentNetns: "net:[12345]",
			}),
		).resolves.toBeDefined();
	});

	it("rejects namespace, address, and proxy mismatches", async () => {
		const path = await writeManifest();
		await expect(
			verifyEgressPolicyReadyFile(path, "api", {
				...identity,
				currentNetns: "net:[99999]",
			}),
		).rejects.toThrow(/namespace/);
		await expect(
			verifyEgressPolicyReadyFile(path, "api", {
				...identity,
				currentIps: ["172.20.0.4"],
			}),
		).rejects.toThrow(/network/);
		await expect(
			verifyEgressPolicyReadyFile(path, "api", {
				...identity,
				proxyAddresses: ["172.20.0.99"],
			}),
		).rejects.toThrow(/proxy address/);
	});

	it("waits a bounded period and fails with the last policy error", async () => {
		const verify = vi.fn(async () => {
			throw new Error("policy file is not ready");
		});
		await expect(
			waitForEgressPolicyReadyFile("unused", "api", {
				timeoutMs: 5,
				pollIntervalMs: 1,
				verify: verify as typeof verifyEgressPolicyReadyFile,
			}),
		).rejects.toThrow(/policy file is not ready/);
		expect(verify).toHaveBeenCalled();
	});
});
