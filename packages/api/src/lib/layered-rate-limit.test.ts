import { describe, expect, it, vi } from "vitest";

import {
	checkLayeredRateLimit,
	RateLimitUnavailableError,
} from "./layered-rate-limit";

describe("checkLayeredRateLimit", () => {
	it.each(["IP", "visitor"] as const)(
		"reports %s limiter backend failures as unavailable",
		async (failedLayer) => {
			const ipRateLimiter = {
				limit: vi.fn(async () => {
					if (failedLayer === "IP") throw new Error("private backend detail");
					return { success: true };
				}),
			};
			const visitorRateLimiter = {
				limit: vi.fn(async () => {
					if (failedLayer === "visitor") {
						throw new Error("private backend detail");
					}
					return { success: true };
				}),
			};

			await expect(
				checkLayeredRateLimit({
					operation: "metadata",
					clientIp: "203.0.113.1",
					identity: { kind: "visitor", visitorId: "visitor-id" },
					ipRateLimiter,
					visitorRateLimiter,
				}),
			).rejects.toBeInstanceOf(RateLimitUnavailableError);

			expect(ipRateLimiter.limit).toHaveBeenCalledTimes(1);
			expect(visitorRateLimiter.limit).toHaveBeenCalledTimes(
				failedLayer === "IP" ? 0 : 1,
			);
		},
	);

	it("still reports exhausted quota as a normal denied result", async () => {
		await expect(
			checkLayeredRateLimit({
				operation: "conversion",
				clientIp: "203.0.113.1",
				identity: { kind: "fallback-ip" },
				ipRateLimiter: { limit: async () => ({ success: true }) },
				visitorRateLimiter: { limit: async () => ({ success: false }) },
				warn: vi.fn(),
			}),
		).resolves.toEqual({ success: false, scope: "fallback-ip" });
	});
});
