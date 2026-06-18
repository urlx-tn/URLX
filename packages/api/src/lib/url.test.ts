import { describe, expect, it } from "vitest";

import { LinkError } from "../modules/links/link.errors";
import { generateShortCode } from "./generate-code";
import { generateSlug } from "./generate-slug";
import { normalizeUrl } from "./normalize-url";
import { isValidShortCode } from "./validate-short-code";
import { validateSlug } from "./validate-slug";
import { maxUrlLength, validateDestinationUrl } from "./validate-url";

function expectLinkError(input: string, code: LinkError["code"]) {
	try {
		validateDestinationUrl(input);
		throw new Error(`Expected ${code} for ${input}`);
	} catch (error) {
		expect(error).toBeInstanceOf(LinkError);
		expect((error as LinkError).code).toBe(code);
	}
}

describe("validateDestinationUrl", () => {
	it("accepts public HTTP(S) domains and IP addresses", () => {
		expect(validateDestinationUrl(" https://Example.com/path ").href).toBe(
			"https://example.com/path",
		);
		expect(validateDestinationUrl("http://8.8.8.8").hostname).toBe("8.8.8.8");
	});

	it.each([
		["", "EMPTY_URL"],
		["not a url", "INVALID_URL"],
		["ftp://example.com", "UNSUPPORTED_PROTOCOL"],
		["https://localhost", "LOCAL_URL_NOT_ALLOWED"],
		["https://api.localhost", "LOCAL_URL_NOT_ALLOWED"],
		["http://127.0.0.1", "PRIVATE_IP_NOT_ALLOWED"],
		["http://10.0.0.1", "PRIVATE_IP_NOT_ALLOWED"],
		["http://172.16.0.1", "PRIVATE_IP_NOT_ALLOWED"],
		["http://192.168.1.1", "PRIVATE_IP_NOT_ALLOWED"],
		["http://[::1]", "PRIVATE_IP_NOT_ALLOWED"],
		["https://internal", "INVALID_DOMAIN"],
	] as const)("rejects %s with %s", (input, code) => {
		expectLinkError(input, code);
	});

	it("rejects URLs over the configured maximum length", () => {
		expectLinkError(
			`https://example.com/${"a".repeat(maxUrlLength)}`,
			"URL_TOO_LONG",
		);
	});
});

describe("URL helpers", () => {
	it("normalizes casing and default ports", () => {
		expect(normalizeUrl(" HTTPS://Example.COM:443/path?q=1 ")).toBe(
			"https://example.com/path?q=1",
		);
	});

	it("validates custom slugs", () => {
		expect(validateSlug(" My-Page ")).toEqual({ ok: true, slug: "my-page" });
		expect(validateSlug("api")).toEqual({
			ok: false,
			reason: "RESERVED_SLUG",
		});
		expect(validateSlug("not valid")).toEqual({
			ok: false,
			reason: "INVALID_SLUG",
		});
	});

	it("validates and generates short identifiers", () => {
		expect(isValidShortCode("Ab3xYz9")).toBe(true);
		expect(isValidShortCode("short")).toBe(false);

		const shortCode = generateShortCode();
		const slug = generateSlug();

		expect(shortCode).toMatch(/^[0-9A-Za-z]{7}$/);
		expect(slug).toMatch(/^[0-9a-z]{8}$/);
	});
});
