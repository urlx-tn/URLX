import { describe, expect, it, vi } from "vitest";

import { checkLayeredRateLimit } from "./layered-rate-limit";

const limiter = (success = true) => ({
	limit: vi.fn(async () => ({ success })),
});

describe("checkLayeredRateLimit", () => {
	it("checks the IP ceiling before the visitor bucket", async () => {
		const order: string[] = [];
		const ipRateLimiter = {
			limit: vi.fn(async () => {
				order.push("ip");
				return { success: true };
			}),
		};
		const visitorRateLimiter = {
			limit: vi.fn(async () => {
				order.push("visitor");
				return { success: true };
			}),
		};

		await expect(
			checkLayeredRateLimit({
				operation: "conversion",
				clientIp: "203.0.113.10",
				identity: {
					kind: "visitor",
					visitorId: "8d78d008-63e5-4e56-a9ed-82824bd87c10",
				},
				ipRateLimiter,
				visitorRateLimiter,
			}),
		).resolves.toEqual({ success: true });
		expect(order).toEqual(["ip", "visitor"]);
		expect(ipRateLimiter.limit).toHaveBeenCalledWith({
			key: "conversion:ip:203.0.113.10",
		});
		expect(visitorRateLimiter.limit).toHaveBeenCalledWith({
			key: "conversion:visitor:8d78d008-63e5-4e56-a9ed-82824bd87c10",
		});
	});

	it("uses the stricter fallback-IP bucket without a valid visitor", async () => {
		const ipRateLimiter = limiter();
		const visitorRateLimiter = limiter();

		await checkLayeredRateLimit({
			operation: "metadata",
			clientIp: "203.0.113.11",
			identity: { kind: "fallback-ip" },
			ipRateLimiter,
			visitorRateLimiter,
		});

		expect(ipRateLimiter.limit).toHaveBeenCalledWith({
			key: "metadata:ip:203.0.113.11",
		});
		expect(visitorRateLimiter.limit).toHaveBeenCalledWith({
			key: "metadata:fallback-ip:203.0.113.11",
		});
	});

	it("stops after a failed IP ceiling and logs only operation and scope", async () => {
		const ipRateLimiter = limiter(false);
		const visitorRateLimiter = limiter();
		const warn = vi.fn();

		await expect(
			checkLayeredRateLimit({
				operation: "conversion",
				clientIp: "sensitive-ip",
				identity: {
					kind: "visitor",
					visitorId: "sensitive-visitor-id",
				},
				ipRateLimiter,
				visitorRateLimiter,
				warn,
			}),
		).resolves.toEqual({ success: false, scope: "ip" });
		expect(visitorRateLimiter.limit).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			JSON.stringify({
				event: "rate_limit_exceeded",
				operation: "conversion",
				scope: "ip",
			}),
		);
		expect(warn.mock.calls.join(" ")).not.toContain("sensitive");
	});

	it("reports visitor and fallback failures with separate operation keys", async () => {
		for (const testCase of [
			{
				operation: "conversion" as const,
				identity: { kind: "visitor" as const, visitorId: "visitor-id" },
				scope: "visitor",
			},
			{
				operation: "metadata" as const,
				identity: { kind: "fallback-ip" as const },
				scope: "fallback-ip",
			},
		]) {
			const warn = vi.fn();
			await expect(
				checkLayeredRateLimit({
					operation: testCase.operation,
					clientIp: "client-ip",
					identity: testCase.identity,
					ipRateLimiter: limiter(),
					visitorRateLimiter: limiter(false),
					warn,
				}),
			).resolves.toEqual({ success: false, scope: testCase.scope });
			expect(warn).toHaveBeenCalledTimes(1);
		}
	});
});
