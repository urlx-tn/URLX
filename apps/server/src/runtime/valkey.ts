import Redis from "ioredis";
import { createValkeyAuthStorage } from "../lib/valkey-auth-storage";
import {
	createValkeyRateLimit,
	rateLimitPolicy,
} from "../lib/valkey-rate-limit";

export function createValkeyRuntime(
	connectionString: string,
	keyMaterial: string,
) {
	const client = new Redis(connectionString, {
		lazyConnect: true,
		maxRetriesPerRequest: 1,
		enableOfflineQueue: false,
		retryStrategy: (attempt) => (attempt <= 3 ? attempt * 100 : null),
	});
	return {
		client,
		authStorage: createValkeyAuthStorage(
			{
				get: (key) => client.get(key),
				set: (key, value, ttlSeconds) =>
					ttlSeconds === undefined
						? client.set(key, value)
						: client.set(key, value, "EX", ttlSeconds),
				del: (key) => client.del(key),
				eval: (script, keyCount, ...args) =>
					client.eval(script, keyCount, ...args),
			},
			keyMaterial,
		),
		limiters: {
			conversionVisitor: createValkeyRateLimit(
				client,
				rateLimitPolicy.conversionVisitor,
				keyMaterial,
			),
			conversionIp: createValkeyRateLimit(
				client,
				rateLimitPolicy.conversionIp,
				keyMaterial,
			),
			metadataVisitor: createValkeyRateLimit(
				client,
				rateLimitPolicy.metadataVisitor,
				keyMaterial,
			),
			metadataIp: createValkeyRateLimit(
				client,
				rateLimitPolicy.metadataIp,
				keyMaterial,
			),
			formsRender: createValkeyRateLimit(
				client,
				rateLimitPolicy.formsRender,
				keyMaterial,
			),
			formsSubmit: createValkeyRateLimit(
				client,
				rateLimitPolicy.formsSubmit,
				keyMaterial,
			),
		},
	};
}

export async function waitForValkey(client: Redis) {
	await client.connect();
	if ((await client.ping()) !== "PONG")
		throw new Error("Valkey health check failed");
}
