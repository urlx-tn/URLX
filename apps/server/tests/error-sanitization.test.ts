import { describe, expect, it } from "vitest";

vi.mock("@resvg/resvg-wasm", () => ({ initWasm: vi.fn(), Resvg: vi.fn() }));
vi.mock("@resvg/resvg-wasm/index_bg.wasm", () => ({
	default: new Uint8Array(),
}));

import { vi } from "vitest";
import { apiApp } from "../src/index";

describe("server error boundary", () => {
	it("hides PostgreSQL diagnostics and bound data behind a request identifier", async () => {
		const secretDiagnostic =
			"SELECT email, answers_json WHERE email='private@example.invalid' password='secret-value'";
		const failingDb = {
			select() {
				throw new Error(secretDiagnostic);
			},
		};
		const response = await apiApp.request(
			"/api/forms/public/synthetic-db-failure",
			{},
			{
				DB: failingDb,
				CORS_ORIGIN: "https://forms.example.invalid",
				FORMS_ENABLED: true,
				BETTER_AUTH_SECRET: "synthetic-test-secret-not-for-deployment",
				BETTER_AUTH_URL: "https://forms.example.invalid",
				RESEND_API_KEY: "re_test_not_sent",
				AUTH_EMAIL_FROM: "URLX <forms@example.invalid>",
				FORMS_RENDER_RATE_LIMIT: { limit: async () => ({ success: true }) },
				FORMS_SUBMIT_RATE_LIMIT: { limit: async () => ({ success: true }) },
			} as never,
		);
		const body = await response.text();
		expect(response.status).toBe(500);
		expect(body).not.toContain(secretDiagnostic);
		expect(body).not.toContain("private@example.invalid");
		expect(body).not.toContain("secret-value");
		expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
	});
});
