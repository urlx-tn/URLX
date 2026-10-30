import { describe, expect, it } from "vitest";
import { normalizeTrustedOrigin } from "./form-link.service";

describe("first-party form origin configuration", () => {
	it("allows a configured loopback origin", () => {
		expect(normalizeTrustedOrigin("http://127.0.0.1:18080")).toBe(
			"http://127.0.0.1:18080",
		);
	});

	it.each([
		"file:///tmp/forms",
		"https://user:pass@forms.example.test",
		"https://forms.example.test/path",
		"https://forms.example.test?next=/",
		"https://forms.example.test#fragment",
	])("rejects non-origin or unsafe configuration: %s", (origin) => {
		expect(() => normalizeTrustedOrigin(origin)).toThrow(
			"Invalid configured first-party origin",
		);
	});
});
