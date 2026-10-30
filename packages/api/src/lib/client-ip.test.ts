import { describe, expect, it } from "vitest";

import { getTrustedClientIp } from "./client-ip";

describe("getTrustedClientIp", () => {
	it("uses only the ingress-overwritten header", () => {
		expect(
			getTrustedClientIp({
				"X-Urlx-Client-IP": "198.51.100.27",
				"CF-Connecting-IP": "203.0.113.9",
				"X-Forwarded-For": "192.0.2.44, 10.0.0.1",
			}),
		).toBe("198.51.100.27");
		expect(
			getTrustedClientIp({
				"CF-Connecting-IP": "203.0.113.9",
				"X-Forwarded-For": "192.0.2.44",
			}),
		).toBe("unknown");
	});

	it("rejects malformed, list-valued, and whitespace-padded header values", () => {
		for (const value of [
			"",
			"198.51.100.1, 127.0.0.1",
			" 198.51.100.1",
			"not-an-ip",
		])
			expect(getTrustedClientIp({ "x-urlx-client-ip": value })).toBe("unknown");
	});

	it("canonicalizes valid IPv6 literals", () => {
		expect(
			getTrustedClientIp({
				"x-urlx-client-ip": "2001:0db8:0000:0000:0000:0000:0000:0001",
			}),
		).toBe("2001:db8::1");
	});
});
