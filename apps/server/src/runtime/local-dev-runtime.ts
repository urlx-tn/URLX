import { createHmac } from "node:crypto";
import type { RateLimiter } from "@urlx/api/lib/layered-rate-limit";
import type { FormsAuthSecondaryStorage } from "@urlx/api/modules/forms/auth";
import { rateLimitPolicy } from "../lib/valkey-rate-limit";

type Entry = { value: string; expiresAt?: number };

/**
 * Process-local state for the explicit native preview only. This is not a
 * fallback for the shared Valkey runtime: local API startup selects it only
 * when NODE_ENV=development and URLX_LOCAL_PREVIEW=true.
 */
export function createLocalDevRuntime(keyMaterial: string, now = Date.now) {
	if (
		process.env.NODE_ENV !== "development" ||
		process.env.URLX_LOCAL_PREVIEW !== "true"
	) {
		throw new Error("Local runtime requires explicit development preview mode");
	}
	if (keyMaterial.length < 32)
		throw new Error("Local runtime key is too short");
	const authValues = new Map<string, Entry>();
	const counters = new Map<string, Entry>();
	const keyFor = (namespace: string, key: string) =>
		`${namespace}:${createHmac("sha256", keyMaterial).update(key).digest("hex")}`;
	const read = (store: Map<string, Entry>, key: string) => {
		const entry = store.get(key);
		if (entry?.expiresAt !== undefined && entry.expiresAt <= now()) {
			store.delete(key);
			return null;
		}
		return entry?.value ?? null;
	};
	const authStorage: FormsAuthSecondaryStorage = {
		async get(key) {
			return read(authValues, keyFor("auth", key));
		},
		async getAndDelete(key) {
			const hashed = keyFor("auth", key);
			const value = read(authValues, hashed);
			// Keep the read and deletion in the same synchronous turn, matching
			// Redis GET+DEL atomicity for this single-process local runtime.
			authValues.delete(hashed);
			return value;
		},
		async increment(key, ttlSeconds) {
			if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
				throw new Error("Invalid auth storage TTL");
			const hashed = keyFor("auth", key);
			const current = Number(read(authValues, hashed) ?? "0");
			if (!Number.isSafeInteger(current) || current < 0)
				throw new Error("Invalid local auth counter");
			const next = current + 1;
			const previous = authValues.get(hashed);
			const expiresAt = previous?.expiresAt ?? now() + ttlSeconds * 1000;
			authValues.set(hashed, { value: String(next), expiresAt });
			return next;
		},
		async set(key, value, ttlSeconds) {
			if (
				ttlSeconds !== undefined &&
				(!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
			)
				throw new Error("Invalid auth storage TTL");
			authValues.set(keyFor("auth", key), {
				value,
				...(ttlSeconds === undefined
					? {}
					: { expiresAt: now() + ttlSeconds * 1000 }),
			});
		},
		async delete(key) {
			authValues.delete(keyFor("auth", key));
		},
	};
	const limiter = (options: {
		limit: number;
		periodSeconds: number;
		namespace: string;
	}): RateLimiter => ({
		async limit({ key }) {
			const periodMs = options.periodSeconds * 1000;
			const timestamp = now();
			const windowStart = Math.floor(timestamp / periodMs) * periodMs;
			const windowKey = keyFor(`rate:${options.namespace}:${windowStart}`, key);
			const current = Number(read(counters, windowKey) ?? "0");
			const next = current + 1;
			counters.set(windowKey, {
				value: String(next),
				expiresAt: windowStart + periodMs,
			});
			return { success: next <= options.limit };
		},
	});
	return {
		authStorage,
		limiters: {
			metadataIp: limiter(rateLimitPolicy.metadataIp),
			metadataVisitor: limiter(rateLimitPolicy.metadataVisitor),
			conversionIp: limiter(rateLimitPolicy.conversionIp),
			conversionVisitor: limiter(rateLimitPolicy.conversionVisitor),
			formsRender: limiter(rateLimitPolicy.formsRender),
			formsSubmit: limiter(rateLimitPolicy.formsSubmit),
		},
	};
}
