import { createHmac } from "node:crypto";
import type { FormsAuthSecondaryStorage } from "@urlx/api/modules/forms/auth";

type ValkeyAuthClient = {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlSeconds?: number): Promise<string | null>;
	del(key: string): Promise<unknown>;
	eval(
		script: string,
		keyCount: number,
		...args: Array<string | number>
	): Promise<unknown>;
};

const getAndDeleteScript = `
local value = redis.call("GET", KEYS[1])
if value then redis.call("DEL", KEYS[1]) end
return value
`;

const incrementScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 or redis.call("TTL", KEYS[1]) < 0 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]))
end
return count
`;

export function createValkeyAuthStorage(
	client: ValkeyAuthClient,
	keyMaterial: string,
): FormsAuthSecondaryStorage {
	if (keyMaterial.length < 32)
		throw new Error("Auth storage key material is too short");
	const keyFor = (key: string) =>
		`urlx:auth:v1:${createHmac("sha256", keyMaterial).update(key).digest("hex")}`;
	return {
		get(key) {
			return client.get(keyFor(key));
		},
		async getAndDelete(key) {
			const value = await client.eval(getAndDeleteScript, 1, keyFor(key));
			if (value === null || value === false) return null;
			if (typeof value !== "string")
				throw new Error("Invalid Valkey auth storage value");
			return value;
		},
		async increment(key, ttlSeconds) {
			if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
				throw new Error("Invalid auth storage TTL");
			const value = await client.eval(
				incrementScript,
				1,
				keyFor(key),
				ttlSeconds,
			);
			const count = typeof value === "number" ? value : Number(value);
			if (!Number.isSafeInteger(count) || count < 1)
				throw new Error("Invalid Valkey auth storage counter");
			return count;
		},
		set(key, value, ttlSeconds) {
			if (
				ttlSeconds !== undefined &&
				(!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
			)
				throw new Error("Invalid auth storage TTL");
			return client.set(keyFor(key), value, ttlSeconds);
		},
		async delete(key) {
			await client.del(keyFor(key));
		},
	};
}

export function getAuthStorageScriptsForTest() {
	return { getAndDeleteScript, incrementScript };
}
