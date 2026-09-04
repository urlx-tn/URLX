import { PUBLIC_SERVER_URL } from "astro:env/client";

const storageKey = "urlx:visitor-token:v1";
const refreshWindowMs = 24 * 60 * 60 * 1000;
const maxTokenLength = 1024;
const tokenPattern = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

type StoredVisitorToken = {
	token: string;
	expiresAt: string;
};

let memoryToken: StoredVisitorToken | null = null;
let pendingTokenRequest: Promise<string | undefined> | null = null;

export async function getAnonymousVisitorToken() {
	if (isUsableRecord(memoryToken)) {
		return memoryToken.token;
	}

	const stored = readStoredToken();
	if (stored) {
		memoryToken = stored;
		return stored.token;
	}

	if (!pendingTokenRequest) {
		pendingTokenRequest = requestVisitorToken().finally(() => {
			pendingTokenRequest = null;
		});
	}
	return pendingTokenRequest;
}

export function handleVisitorTokenRefresh(response: Response) {
	if (response.headers.get("X-URLX-Visitor-Token-Refresh") === "required") {
		clearAnonymousVisitorToken();
	}
}

export function clearAnonymousVisitorToken() {
	memoryToken = null;
	try {
		localStorage.removeItem(storageKey);
	} catch {
		// Storage may be disabled; the in-memory copy has still been cleared.
	}
}

async function requestVisitorToken() {
	try {
		const response = await fetch(`${PUBLIC_SERVER_URL}/visitor-token`, {
			method: "GET",
			cache: "no-store",
		});
		if (!response.ok) {
			return undefined;
		}

		const payload: unknown = await response.json();
		if (!isUsableRecord(payload)) {
			return undefined;
		}

		memoryToken = payload;
		try {
			localStorage.setItem(storageKey, JSON.stringify(payload));
		} catch {
			// The token remains available in memory for this page.
		}
		return payload.token;
	} catch {
		return undefined;
	}
}

function readStoredToken() {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) {
			return null;
		}
		const parsed: unknown = JSON.parse(raw);
		if (isUsableRecord(parsed)) {
			return parsed;
		}
		localStorage.removeItem(storageKey);
	} catch {
		// Malformed or unavailable storage falls back to token issuance/IP limiting.
	}
	return null;
}

function isUsableRecord(value: unknown): value is StoredVisitorToken {
	if (!value || typeof value !== "object") {
		return false;
	}
	if (Object.keys(value).sort().join(",") !== "expiresAt,token") {
		return false;
	}
	const candidate = value as Partial<StoredVisitorToken>;
	if (
		typeof candidate.token !== "string" ||
		candidate.token.length > maxTokenLength ||
		!tokenPattern.test(candidate.token) ||
		typeof candidate.expiresAt !== "string"
	) {
		return false;
	}
	const expiresAt = Date.parse(candidate.expiresAt);
	return Number.isFinite(expiresAt) && expiresAt > Date.now() + refreshWindowMs;
}
