import { createHmac } from "node:crypto";

export type RateLimitBinding = {
	limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type ValkeyScriptClient = {
	eval(
		script: string,
		keyCount: number,
		...args: Array<string | number>
	): Promise<unknown>;
};

const fixedWindowScript = `
local currentTime = redis.call("TIME")
local nowMs = tonumber(currentTime[1]) * 1000 + math.floor(tonumber(currentTime[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local windowNumber = math.floor(nowMs / windowMs)
local windowKey = KEYS[1] .. ":" .. tostring(windowNumber)
local count = redis.call("INCR", windowKey)
if count == 1 or redis.call("PTTL", windowKey) < 0 then
  redis.call("PEXPIRE", windowKey, windowMs - (nowMs % windowMs))
end
if count > tonumber(ARGV[2]) then
  return 0
end
return 1
`;

/**
 * Creates a shared fixed-window limiter. Redis TIME and EVAL make both the
 * boundary calculation and increment atomic across API/conversion replicas.
 * Errors intentionally propagate: production never falls back to process-local
 * counters when shared rate state is unavailable.
 */
export function createValkeyRateLimit(
	client: ValkeyScriptClient,
	options: { limit: number; periodSeconds: number; namespace: string },
	keyMaterial: string,
): RateLimitBinding {
	if (
		!Number.isSafeInteger(options.limit) ||
		options.limit < 1 ||
		!Number.isSafeInteger(options.periodSeconds) ||
		options.periodSeconds < 1 ||
		!/^[a-z0-9:_-]{1,80}$/i.test(options.namespace) ||
		typeof keyMaterial !== "string" ||
		keyMaterial.length < 32
	) {
		throw new Error("Invalid Valkey rate-limit configuration");
	}

	return {
		async limit({ key }) {
			const digest = createHmac("sha256", keyMaterial)
				.update(key)
				.digest("hex");
			const result = await client.eval(
				fixedWindowScript,
				1,
				`urlx:rate:v1:${options.namespace}:${digest}`,
				options.periodSeconds * 1000,
				options.limit,
			);
			if (result !== 0 && result !== 1) {
				throw new Error("Valkey returned an invalid rate-limit result");
			}
			return { success: result === 1 };
		},
	};
}

export const rateLimitPolicy = {
	conversionVisitor: {
		limit: 15,
		periodSeconds: 60,
		namespace: "conversion:visitor",
	},
	conversionIp: { limit: 60, periodSeconds: 60, namespace: "conversion:ip" },
	metadataVisitor: {
		limit: 60,
		periodSeconds: 60,
		namespace: "metadata:visitor",
	},
	metadataIp: { limit: 240, periodSeconds: 60, namespace: "metadata:ip" },
	formsRender: { limit: 30, periodSeconds: 60, namespace: "forms:render" },
	formsSubmit: { limit: 10, periodSeconds: 60, namespace: "forms:submit" },
} as const;

const fixedWindowScriptSource = fixedWindowScript;

export function getFixedWindowRateLimitScriptForTest() {
	return fixedWindowScriptSource;
}
