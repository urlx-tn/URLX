export type RateLimiter = {
	limit(input: { key: string }): Promise<{ success: boolean }>;
};

export class RateLimitUnavailableError extends Error {
	constructor() {
		super("The rate limit service is unavailable.");
		this.name = "RateLimitUnavailableError";
	}
}

export type RateLimitOperation = "conversion" | "metadata";
export type RateLimitScope = "visitor" | "fallback-ip" | "ip";
export type RateLimitIdentity =
	| { kind: "visitor"; visitorId: string }
	| { kind: "fallback-ip" };

export type LayeredRateLimitOptions = {
	operation: RateLimitOperation;
	clientIp: string;
	identity: RateLimitIdentity;
	ipRateLimiter: RateLimiter;
	visitorRateLimiter: RateLimiter;
	warn?: (message: string) => void;
};

export type LayeredRateLimitResult =
	| { success: true }
	| { success: false; scope: RateLimitScope };

export async function checkLayeredRateLimit(
	options: LayeredRateLimitOptions,
): Promise<LayeredRateLimitResult> {
	const ipResult = await checkLimiter(options.ipRateLimiter, {
		key: `${options.operation}:ip:${options.clientIp}`,
	});
	if (!ipResult.success) {
		warnExceeded(options, "ip");
		return { success: false, scope: "ip" };
	}

	const scope = options.identity.kind;
	const identifier =
		options.identity.kind === "visitor"
			? options.identity.visitorId
			: options.clientIp;
	const visitorResult = await checkLimiter(options.visitorRateLimiter, {
		key: `${options.operation}:${scope}:${identifier}`,
	});
	if (!visitorResult.success) {
		warnExceeded(options, scope);
		return { success: false, scope };
	}

	return { success: true };
}

async function checkLimiter(
	limiter: RateLimiter,
	input: { key: string },
): Promise<{ success: boolean }> {
	try {
		return await limiter.limit(input);
	} catch {
		throw new RateLimitUnavailableError();
	}
}

function warnExceeded(options: LayeredRateLimitOptions, scope: RateLimitScope) {
	const warn = options.warn ?? console.warn;
	warn(
		JSON.stringify({
			event: "rate_limit_exceeded",
			operation: options.operation,
			scope,
		}),
	);
}
