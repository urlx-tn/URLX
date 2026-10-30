import { parseApiServerEnv } from "@urlx/env/server";
import { describe, expect, it } from "vitest";

function generatedSecret() {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"base64",
	);
}

function apiEnvironment(overrides: Record<string, string | undefined> = {}) {
	return {
		DATABASE_URL: "postgresql://urlx_app:app-password@postgres:5432/urlx",
		VALKEY_URL: "redis://valkey:6379",
		VISITOR_TOKEN_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
		CORS_ORIGIN: "https://urlx.example",
		EGRESS_PROXY_URL: "http://egress-proxy:3128",
		EGRESS_POLICY_READY_FILE: "/run/urlx-egress/ready.json",
		FORMS_ENABLED: "true",
		BETTER_AUTH_SECRET: generatedSecret(),
		BETTER_AUTH_URL: "https://urlx.example",
		RESEND_API_KEY: "re_test-key",
		AUTH_EMAIL_FROM: "URLX <forms@example.invalid>",
		...overrides,
	};
}

describe("API runtime environment validation", () => {
	it("requires a long non-placeholder auth secret only when forms are enabled", () => {
		expect(() =>
			parseApiServerEnv(apiEnvironment({ BETTER_AUTH_SECRET: "short" })),
		).toThrow(/BETTER_AUTH_SECRET must be at least 32 bytes/);
		expect(() =>
			parseApiServerEnv(apiEnvironment({ BETTER_AUTH_SECRET: "x".repeat(32) })),
		).toThrow(/must not be a placeholder value/);
		expect(() =>
			parseApiServerEnv(
				apiEnvironment({ BETTER_AUTH_SECRET: "😀".repeat(32) }),
			),
		).toThrow(/must not be a placeholder value/);
		expect(() =>
			parseApiServerEnv(
				apiEnvironment({ BETTER_AUTH_SECRET: "your-secret-here" }),
			),
		).toThrow(/must not be a placeholder value/);

		const formsDisabled = apiEnvironment({
			FORMS_ENABLED: "false",
			BETTER_AUTH_SECRET: "short",
		});
		expect(parseApiServerEnv(formsDisabled).FORMS_ENABLED).toBe("false");
	});

	it("accepts a generated-length secret and never includes rejected secret material in diagnostics", () => {
		const secret = generatedSecret();
		expect(
			parseApiServerEnv(apiEnvironment({ BETTER_AUTH_SECRET: secret }))
				.BETTER_AUTH_SECRET,
		).toBe(secret);

		const weakSecret = "your-secret-here";
		try {
			parseApiServerEnv(apiEnvironment({ BETTER_AUTH_SECRET: weakSecret }));
			throw new Error("Expected invalid auth secret to fail validation");
		} catch (error) {
			expect(String(error)).not.toContain(weakSecret);
			expect(String(error)).toContain("BETTER_AUTH_SECRET");
		}
	});
});
