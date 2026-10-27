import { isIP } from "node:net";

/** Only trusts the header that the self-hosted ingress overwrites from its socket peer. */
export function getTrustedClientIp(
	headers: Headers | Record<string, string | undefined>,
): string {
	const raw =
		headers instanceof Headers
			? headers.get("x-urlx-client-ip")
			: getHeader(headers, "x-urlx-client-ip");
	if (!raw) return "unknown";
	const candidate = raw.trim();
	if (candidate !== raw || candidate.includes(",") || isIP(candidate) === 0)
		return "unknown";
	if (isIP(candidate) === 6) {
		try {
			return new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
		} catch {
			return "unknown";
		}
	}
	return candidate;
}

function getHeader(
	headers: Record<string, string | undefined>,
	name: string,
): string | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
}
