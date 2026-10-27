import { parseConversionServerEnv } from "@urlx/env/server";
import { describe, expect, it } from "vitest";

function conversionEnvironment(
	overrides: Record<string, string | undefined> = {},
) {
	return {
		VALKEY_URL: "redis://valkey:6379",
		VISITOR_TOKEN_KEY_BASE64: Buffer.alloc(32, 5).toString("base64"),
		CORS_ORIGIN: "https://urlx.example",
		BROWSER_RENDERER_URL: "http://conversion-renderer:3100",
		EGRESS_POLICY_READY_FILE: "/run/urlx-egress/ready.json",
		...overrides,
	};
}

describe("conversion runtime environment validation", () => {
	it("defaults browser conversion to enabled and requires a renderer URL", () => {
		expect(
			parseConversionServerEnv(conversionEnvironment())
				.CONVERSION_BROWSER_DISABLED,
		).toBe("false");
		expect(() =>
			parseConversionServerEnv(
				conversionEnvironment({ BROWSER_RENDERER_URL: undefined }),
			),
		).toThrow(/BROWSER_RENDERER_URL is required/);
	});

	it("accepts the explicit disabled mode without a browser renderer URL", () => {
		const env = parseConversionServerEnv(
			conversionEnvironment({
				BROWSER_RENDERER_URL: undefined,
				CONVERSION_BROWSER_DISABLED: "true",
			}),
		);
		expect(env.CONVERSION_BROWSER_DISABLED).toBe("true");
		expect(env.BROWSER_RENDERER_URL).toBeUndefined();
	});

	it.each(["yes", "1", "TRUE"])(
		"rejects a non-literal disabled setting (%s)",
		(setting) => {
			expect(() =>
				parseConversionServerEnv(
					conversionEnvironment({
						CONVERSION_BROWSER_DISABLED: setting,
					}),
				),
			).toThrow(/CONVERSION_BROWSER_DISABLED/);
		},
	);
});
