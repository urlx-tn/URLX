import { PUBLIC_SERVER_URL } from "astro:env/client";
import { INTERNAL_SERVER_URL } from "astro:env/server";

export async function proxyApiRequest(request: Request, path: string) {
	const incoming = new URL(request.url);
	// Astro's catch-all route supplies an empty path as `/`; Hono mounts the
	// collection endpoint without a trailing slash.
	const normalizedPath = path.length > 1 ? path.replace(/\/$/, "") : path;
	const apiBase =
		INTERNAL_SERVER_URL ||
		(isLocalUrl(PUBLIC_SERVER_URL) ? PUBLIC_SERVER_URL : null);
	if (!apiBase) {
		return unavailable();
	}
	const target = new URL(normalizedPath, apiBase);
	target.search = incoming.search;
	const forwarded = new Request(target, {
		method: request.method,
		headers: request.headers,
		body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
		redirect: "manual",
		...(request.body ? { duplex: "half" as const } : {}),
	});

	try {
		return await fetch(forwarded);
	} catch {
		return unavailable();
	}
}

function isLocalUrl(value: string) {
	try {
		return ["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname);
	} catch {
		return false;
	}
}

function unavailable() {
	return new Response("Forms API is unavailable", {
		status: 503,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}
