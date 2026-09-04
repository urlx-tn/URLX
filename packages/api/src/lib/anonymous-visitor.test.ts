import { beforeAll, describe, expect, it } from "vitest";

import {
	issueAnonymousVisitorToken,
	maxAnonymousVisitorTokenLength,
	verifyAnonymousVisitorToken,
} from "./anonymous-visitor";

const nowMs = Date.parse("2026-09-04T12:00:00.000Z");
const visitorId = "8d78d008-63e5-4e56-a9ed-82824bd87c10";
const lifetimeSeconds = 30 * 24 * 60 * 60;
let key: CryptoKey;

beforeAll(async () => {
	key = await crypto.subtle.importKey(
		"raw",
		new Uint8Array(32).fill(7),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
});

describe("anonymous visitor tokens", () => {
	it("issues a v1 token with a deterministic UUID and 30-day expiry", async () => {
		const issued = await issueAnonymousVisitorToken({
			key,
			now: () => nowMs,
			uuid: () => visitorId,
		});

		expect(issued.token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(issued.expiresAt).toBe("2026-10-04T12:00:00.000Z");
		await expect(
			verifyAnonymousVisitorToken(issued.token, key, () => nowMs),
		).resolves.toEqual({
			status: "valid",
			visitorId,
			expiresAt: Math.floor(nowMs / 1000) + lifetimeSeconds,
		});
	});

	it("distinguishes missing tokens from invalid tokens", async () => {
		await expect(
			verifyAnonymousVisitorToken(undefined, key, () => nowMs),
		).resolves.toEqual({ status: "missing" });
		await expect(
			verifyAnonymousVisitorToken("", key, () => nowMs),
		).resolves.toEqual({ status: "missing" });
		await expect(
			verifyAnonymousVisitorToken("not-a-token", key, () => nowMs),
		).resolves.toEqual({ status: "invalid" });
	});

	it("rejects altered payloads and signatures", async () => {
		const issued = await issueAnonymousVisitorToken({
			key,
			now: () => nowMs,
			uuid: () => visitorId,
		});
		const [version, payload, signature] = issued.token.split(".") as [
			string,
			string,
			string,
		];

		await expect(
			verifyAnonymousVisitorToken(
				`${version}.${payload.slice(0, -1)}A.${signature}`,
				key,
				() => nowMs,
			),
		).resolves.toEqual({ status: "invalid" });
		await expect(
			verifyAnonymousVisitorToken(
				`${version}.${payload}.${signature.slice(0, -1)}A`,
				key,
				() => nowMs,
			),
		).resolves.toEqual({ status: "invalid" });
	});

	it.each([
		"v2.payload.signature",
		"v1.***.signature",
		"v1.abcde.signature",
		"v1.e30.signature.extra",
	])("rejects malformed token %s", async (token) => {
		await expect(
			verifyAnonymousVisitorToken(token, key, () => nowMs),
		).resolves.toEqual({ status: "invalid" });
	});

	it("rejects malformed JSON and incorrectly shaped payloads", async () => {
		const nowSeconds = Math.floor(nowMs / 1000);
		const payloads = [
			"not-json",
			JSON.stringify({ iat: nowSeconds, exp: nowSeconds + lifetimeSeconds }),
			JSON.stringify({
				id: "not-a-uuid",
				iat: nowSeconds,
				exp: nowSeconds + lifetimeSeconds,
			}),
			JSON.stringify({
				id: visitorId,
				iat: nowSeconds,
				exp: nowSeconds + lifetimeSeconds,
				extra: true,
			}),
		];

		for (const payload of payloads) {
			const token = await signPayload(payload);
			await expect(
				verifyAnonymousVisitorToken(token, key, () => nowMs),
			).resolves.toEqual({ status: "invalid" });
		}
	});

	it("rejects expired, future-dated, invalid-lifetime, and oversized tokens", async () => {
		const nowSeconds = Math.floor(nowMs / 1000);
		const payloads = [
			{
				id: visitorId,
				iat: nowSeconds - lifetimeSeconds,
				exp: nowSeconds,
			},
			{
				id: visitorId,
				iat: nowSeconds + 301,
				exp: nowSeconds + 301 + lifetimeSeconds,
			},
			{ id: visitorId, iat: nowSeconds, exp: nowSeconds + 10 },
		];

		for (const payload of payloads) {
			const token = await signPayload(JSON.stringify(payload));
			await expect(
				verifyAnonymousVisitorToken(token, key, () => nowMs),
			).resolves.toEqual({ status: "invalid" });
		}
		await expect(
			verifyAnonymousVisitorToken(
				"x".repeat(maxAnonymousVisitorTokenLength + 1),
				key,
				() => nowMs,
			),
		).resolves.toEqual({ status: "invalid" });
	});

	it("does not leak key material when verification cannot use the key", async () => {
		const aesKey = await crypto.subtle.importKey(
			"raw",
			new Uint8Array(32).fill(99),
			"AES-GCM",
			false,
			["encrypt"],
		);
		const token = await signPayload(
			JSON.stringify({
				id: visitorId,
				iat: Math.floor(nowMs / 1000),
				exp: Math.floor(nowMs / 1000) + lifetimeSeconds,
			}),
		);
		await expect(
			verifyAnonymousVisitorToken(token, aesKey, () => nowMs),
		).resolves.toEqual({ status: "invalid" });
	});
});

async function signPayload(json: string) {
	const payload = encodeBase64Url(new TextEncoder().encode(json));
	const signedValue = `v1.${payload}`;
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(signedValue),
	);
	return `${signedValue}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function encodeBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
