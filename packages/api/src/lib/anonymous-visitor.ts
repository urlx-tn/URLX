const tokenVersion = "v1";
const tokenLifetimeSeconds = 30 * 24 * 60 * 60;
const maxFutureSkewSeconds = 5 * 60;
export const maxAnonymousVisitorTokenLength = 1024;

const encoder = new TextEncoder();
const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

type AnonymousVisitorPayload = {
	id: string;
	iat: number;
	exp: number;
};

export type AnonymousVisitorVerification =
	| { status: "valid"; visitorId: string; expiresAt: number }
	| { status: "missing" }
	| { status: "invalid" };

export type IssueAnonymousVisitorTokenOptions = {
	key: CryptoKey;
	now?: () => number;
	uuid?: () => string;
};

export async function issueAnonymousVisitorToken(
	options: IssueAnonymousVisitorTokenOptions,
) {
	const issuedAt = Math.floor((options.now?.() ?? Date.now()) / 1000);
	const payload: AnonymousVisitorPayload = {
		id: options.uuid?.() ?? crypto.randomUUID(),
		iat: issuedAt,
		exp: issuedAt + tokenLifetimeSeconds,
	};
	const encodedPayload = encodeBase64Url(
		encoder.encode(JSON.stringify(payload)),
	);
	const signedValue = `${tokenVersion}.${encodedPayload}`;
	const signature = await crypto.subtle.sign(
		"HMAC",
		options.key,
		encoder.encode(signedValue),
	);

	return {
		token: `${signedValue}.${encodeBase64Url(new Uint8Array(signature))}`,
		expiresAt: new Date(payload.exp * 1000).toISOString(),
	};
}

export async function verifyAnonymousVisitorToken(
	token: string | null | undefined,
	key: CryptoKey,
	now: () => number = Date.now,
): Promise<AnonymousVisitorVerification> {
	if (token === undefined || token === null || token === "") {
		return { status: "missing" };
	}

	if (token.length > maxAnonymousVisitorTokenLength) {
		return { status: "invalid" };
	}

	try {
		const parts = token.split(".");
		if (
			parts.length !== 3 ||
			parts[0] !== tokenVersion ||
			!parts[1] ||
			!parts[2] ||
			!base64UrlPattern.test(parts[1]) ||
			!base64UrlPattern.test(parts[2])
		) {
			return { status: "invalid" };
		}

		const payloadBytes = decodeBase64Url(parts[1]);
		if (encodeBase64Url(payloadBytes) !== parts[1]) {
			return { status: "invalid" };
		}
		const payload = parsePayload(payloadBytes);
		if (!payload) {
			return { status: "invalid" };
		}

		const nowSeconds = Math.floor(now() / 1000);
		if (
			payload.iat > nowSeconds + maxFutureSkewSeconds ||
			payload.exp <= nowSeconds ||
			payload.exp - payload.iat !== tokenLifetimeSeconds
		) {
			return { status: "invalid" };
		}

		const signature = decodeBase64Url(parts[2]);
		if (encodeBase64Url(signature) !== parts[2]) {
			return { status: "invalid" };
		}
		const validSignature = await crypto.subtle.verify(
			"HMAC",
			key,
			signature,
			encoder.encode(`${tokenVersion}.${parts[1]}`),
		);
		if (!validSignature) {
			return { status: "invalid" };
		}

		return {
			status: "valid",
			visitorId: payload.id,
			expiresAt: payload.exp,
		};
	} catch {
		return { status: "invalid" };
	}
}

function parsePayload(bytes: Uint8Array): AnonymousVisitorPayload | null {
	const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}

	const keys = Object.keys(parsed).sort();
	if (keys.join(",") !== "exp,iat,id") {
		return null;
	}

	const candidate = parsed as Record<string, unknown>;
	if (
		typeof candidate.id !== "string" ||
		!uuidPattern.test(candidate.id) ||
		typeof candidate.iat !== "number" ||
		!Number.isSafeInteger(candidate.iat) ||
		typeof candidate.exp !== "number" ||
		!Number.isSafeInteger(candidate.exp)
	) {
		return null;
	}

	return candidate as AnonymousVisitorPayload;
}

function encodeBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
	if (!base64UrlPattern.test(value) || value.length % 4 === 1) {
		throw new Error("Invalid base64url value");
	}

	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
