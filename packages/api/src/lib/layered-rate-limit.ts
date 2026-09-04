type RateLimiter = Pick<RateLimit, "limit">;

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
	const ipResult = await options.ipRateLimiter.limit({
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
	const visitorResult = await options.visitorRateLimiter.limit({
		key: `${options.operation}:${scope}:${identifier}`,
	});
	if (!visitorResult.success) {
		warnExceeded(options, scope);
		return { success: false, scope };
	}

	return { success: true };
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
