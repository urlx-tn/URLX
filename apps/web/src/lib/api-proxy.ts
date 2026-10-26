import { env } from "cloudflare:workers";

export async function proxyApiRequest(request: Request, path: string) {
	const runtimeEnv = env as typeof env & {
		API?: { fetch: (request: Request) => Promise<Response> };
		PUBLIC_SERVER_URL?: string;
	};
	const incoming = new URL(request.url);
	// Astro's catch-all route supplies an empty path as `/`; Hono mounts the
	// collection endpoint without a trailing slash.
	const normalizedPath = path.length > 1 ? path.replace(/\/$/, "") : path;
	const target = new URL(normalizedPath, incoming.origin);
	target.search = incoming.search;
	const createForwardedRequest = () =>
		new Request(target, {
			method: request.method,
			headers: request.headers,
			body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
			redirect: "manual",
			...(request.body ? { duplex: "half" as const } : {}),
		});
	const service = runtimeEnv.API;
	if (service && typeof service.fetch === "function") {
		return service.fetch(createForwardedRequest());
	}

	// Bare Astro development can use a local server process. Refuse any remote
	// target here so developer forms traffic cannot silently reach a shared DB.
	const configuredUrl = runtimeEnv.PUBLIC_SERVER_URL;
	if (typeof configuredUrl === "string") {
		const base = new URL(configuredUrl);
		if (["localhost", "127.0.0.1", "::1"].includes(base.hostname)) {
			target.host = base.host;
			target.protocol = base.protocol;
			return fetch(createForwardedRequest());
		}
	}

	return new Response("Forms API is unavailable", {
		status: 503,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}
