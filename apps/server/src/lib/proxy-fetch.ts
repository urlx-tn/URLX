type ProxyRequestInit = RequestInit & { proxy: string };
export type PortableFetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Require the named, private Compose proxy endpoint. This is intentionally not
 * inferred from HTTP_PROXY/NO_PROXY, because ambient bypass lists can route
 * caller-controlled URLs around the SSRF policy.
 */
export function requireEgressProxyUrl(value: string | undefined): string {
	if (!value) throw new Error("EGRESS_PROXY_URL is required");
	let proxy: URL;
	try {
		proxy = new URL(value);
	} catch {
		throw new Error("EGRESS_PROXY_URL must be a valid URL");
	}
	if (
		proxy.protocol !== "http:" ||
		proxy.hostname !== "egress-proxy" ||
		proxy.port !== "3128" ||
		proxy.username ||
		proxy.password ||
		(proxy.pathname !== "/" && proxy.pathname !== "") ||
		proxy.search ||
		proxy.hash
	) {
		throw new Error("EGRESS_PROXY_URL must target http://egress-proxy:3128");
	}
	return proxy.origin;
}

/**
 * Bun's explicit per-request proxy option overrides NO_PROXY. The Docker
 * network/firewall remains the security boundary if the proxy is unavailable.
 */
export function createProxyFetcher(
	proxyUrl: string,
	fetchImpl: typeof fetch = globalThis.fetch,
): PortableFetcher {
	const proxy = requireEgressProxyUrl(proxyUrl);
	return (input, init) =>
		fetchImpl(input, {
			...init,
			proxy,
		} as ProxyRequestInit);
}
