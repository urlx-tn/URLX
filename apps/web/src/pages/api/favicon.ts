import type { APIRoute } from "astro";

const maxHostLength = 253;

export const GET: APIRoute = async ({ url }) => {
	const host = normalizeHost(url.searchParams.get("host") ?? "");

	if (!host) {
		return fallbackIcon("?", "public, max-age=86400");
	}

	const icon = await fetchGoogleFavicon(host);
	return (
		icon ??
		fallbackIcon(
			host.charAt(0),
			"private, no-store, max-age=0, must-revalidate",
		)
	);
};

async function fetchGoogleFavicon(host: string) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2500);

	try {
		const response = await fetch(
			`https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(`https://${host}`)}&size=64`,
			{
				cf: { cacheTtl: 86400, cacheEverything: true },
				signal: controller.signal,
			},
		);

		if (!response.ok) {
			return null;
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.startsWith("image/")) {
			return null;
		}

		const bytes = await response.arrayBuffer();
		if (bytes.byteLength === 0 || bytes.byteLength > 65536) {
			return null;
		}

		return new Response(bytes, {
			headers: {
				"cache-control": "public, max-age=86400, stale-while-revalidate=86400",
				"content-type": contentType,
			},
		});
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

function normalizeHost(value: string) {
	const host = value
		.trim()
		.toLowerCase()
		.replace(/^www\./, "")
		.slice(0, maxHostLength);

	if (!/^[a-z0-9.-]+$/.test(host)) {
		return "";
	}

	return hasPublicTld(host) ? host : "";
}

function fallbackIcon(letter: string, cacheControl: string) {
	const safeLetter = escapeSvg(letter.toUpperCase() || "?");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#f5f5f7"/><text x="32" y="39" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="28" font-weight="700" fill="#6e6e73">${safeLetter}</text></svg>`;

	return new Response(svg, {
		headers: {
			"cache-control": cacheControl,
			"content-type": "image/svg+xml; charset=utf-8",
		},
	});
}

function escapeSvg(value: string) {
	return value.replace(/[&<>"']/g, (char) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};

		return entities[char] ?? char;
	});
}

function hasPublicTld(hostname: string) {
	const labels = hostname.split(".");

	if (labels.length < 2 || labels.some((label) => label.length === 0)) {
		return false;
	}

	const tld = labels[labels.length - 1] ?? "";

	return /^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9]+$/.test(tld);
}
