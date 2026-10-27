import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createValkeyAuthStorage,
	getAuthStorageScriptsForTest,
} from "../src/lib/valkey-auth-storage";

describe("Better Auth Valkey secondary storage", () => {
	it("uses namespaced hashed keys and atomic GETDEL/INCR+EXPIRE scripts", async () => {
		const evalScript = vi.fn(
			async (
				script: string,
				_keyCount: number,
				..._args: Array<string | number>
			) => (script.includes('redis.call("INCR"') ? 1 : "single-use-token"),
		);
		const client = {
			get: vi.fn(async (_key: string) => "saved"),
			set: vi.fn(
				async (_key: string, _value: string, _ttlSeconds?: number) =>
					"OK" as const,
			),
			del: vi.fn(async (_key: string) => 1),
			eval: evalScript,
		};
		const keyMaterial = "test-key-material-value-at-least-thirty-two-bytes";
		const storage = createValkeyAuthStorage(client, keyMaterial);
		expect(await storage.get("magic-link-token:private-value")).toBe("saved");
		const getArgs = client.get.mock.calls[0]?.[0] ?? "";
		expect(getArgs).toBe(
			`urlx:auth:v1:${createHmac("sha256", keyMaterial).update("magic-link-token:private-value").digest("hex")}`,
		);
		expect(getArgs).not.toContain("private-value");
		expect(await storage.getAndDelete("magic-link-token:private-value")).toBe(
			"single-use-token",
		);
		expect(await storage.increment("rate-limit:ip", 60)).toBe(1);
		expect(evalScript.mock.calls[0]?.[0]).toContain(
			'redis.call("DEL", KEYS[1])',
		);
		expect(evalScript.mock.calls[1]?.[0]).toContain(
			'redis.call("EXPIRE", KEYS[1]',
		);
		expect(evalScript.mock.calls[1]?.[3]).toBe(60);
	});

	it("supports optional TTLs and deletes without exposing adapter errors", async () => {
		const client = {
			get: vi.fn(async (_key: string) => null),
			set: vi.fn(
				async (_key: string, _value: string, _ttlSeconds?: number) =>
					"OK" as const,
			),
			del: vi.fn(async (_key: string) => 1),
			eval: vi.fn(
				async (
					_script: string,
					_keyCount: number,
					..._args: Array<string | number>
				) => null,
			),
		};
		const storage = createValkeyAuthStorage(
			client,
			"test-key-material-value-at-least-thirty-two-bytes",
		);
		await storage.set("key", "value");
		await storage.set("expiring", "value", 30);
		await storage.delete("key");
		expect(client.set.mock.calls[0]?.[2]).toBeUndefined();
		expect(client.set.mock.calls[1]?.[2]).toBe(30);
		expect(client.del).toHaveBeenCalledTimes(1);
		await expect(storage.getAndDelete("missing")).resolves.toBeNull();
		await expect(storage.increment("key", 0)).rejects.toThrow(/TTL/);
	});

	it("does not fall back when Valkey fails", async () => {
		const storage = createValkeyAuthStorage(
			{
				get: async () => null,
				set: async () => "OK",
				del: async () => 1,
				eval: async () => {
					throw new Error("Valkey unavailable");
				},
			},
			"test-key-material-value-at-least-thirty-two-bytes",
		);
		await expect(storage.increment("rate-key", 10)).rejects.toThrow(
			"Valkey unavailable",
		);
		expect(getAuthStorageScriptsForTest().incrementScript).toContain(
			"if count == 1",
		);
		expect(getAuthStorageScriptsForTest().incrementScript).toContain(
			'redis.call("TTL", KEYS[1]) < 0',
		);
	});
});
