import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
	createValkeyRateLimit,
	rateLimitPolicy,
} from "../src/lib/valkey-rate-limit";

describe("Valkey shared rate limits", () => {
	it("uses a Redis-side time window and hashes the identity key", async () => {
		const evalScript = vi.fn().mockResolvedValue(1);
		const limiter = createValkeyRateLimit(
			{ eval: evalScript },
			{
				limit: 15,
				periodSeconds: 60,
				namespace: "conversion:visitor",
			},
			"test-key-material-value-at-least-thirty-two-bytes",
		);

		await expect(
			limiter.limit({ key: "conversion:visitor:private-id" }),
		).resolves.toEqual({
			success: true,
		});
		const [script, keyCount, redisKey, windowMs, limit] =
			evalScript.mock.calls[0] ?? [];
		expect(keyCount).toBe(1);
		expect(redisKey).toBe(
			`urlx:rate:v1:conversion:visitor:${createHmac("sha256", "test-key-material-value-at-least-thirty-two-bytes").update("conversion:visitor:private-id").digest("hex")}`,
		);
		expect(String(script)).toContain('redis.call("TIME")');
		expect(String(script)).toContain('redis.call("INCR", windowKey)');
		expect(String(script)).toContain('redis.call("PTTL", windowKey) < 0');
		expect(windowMs).toBe(60_000);
		expect(limit).toBe(15);
		expect(String(redisKey)).not.toContain("private-id");
	});

	it("returns a denial for an atomic over-limit result and propagates Valkey failures", async () => {
		const limiter = createValkeyRateLimit(
			{ eval: vi.fn().mockResolvedValue(0) },
			{ limit: 1, periodSeconds: 60, namespace: "forms:submit" },
			"test-key-material-value-at-least-thirty-two-bytes",
		);
		await expect(limiter.limit({ key: "ip:192.0.2.1" })).resolves.toEqual({
			success: false,
		});

		const unavailable = createValkeyRateLimit(
			{ eval: vi.fn().mockRejectedValue(new Error("down")) },
			{ limit: 1, periodSeconds: 60, namespace: "forms:submit" },
			"test-key-material-value-at-least-thirty-two-bytes",
		);
		await expect(unavailable.limit({ key: "ip:192.0.2.1" })).rejects.toThrow(
			"down",
		);
	});

	it("keeps the existing per-route quotas", () => {
		expect(rateLimitPolicy).toEqual({
			conversionVisitor: {
				limit: 15,
				periodSeconds: 60,
				namespace: "conversion:visitor",
			},
			conversionIp: {
				limit: 60,
				periodSeconds: 60,
				namespace: "conversion:ip",
			},
			metadataVisitor: {
				limit: 60,
				periodSeconds: 60,
				namespace: "metadata:visitor",
			},
			metadataIp: { limit: 240, periodSeconds: 60, namespace: "metadata:ip" },
			formsRender: { limit: 30, periodSeconds: 60, namespace: "forms:render" },
			formsSubmit: { limit: 10, periodSeconds: 60, namespace: "forms:submit" },
		});
	});
});
