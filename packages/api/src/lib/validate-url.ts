import { LinkError } from "../modules/links/link.errors";

export const maxUrlLength = 2048;

export function validateDestinationUrl(rawUrl: string) {
	const trimmedUrl = rawUrl.trim();

	if (!trimmedUrl) {
		throw new LinkError("EMPTY_URL");
	}

	if (trimmedUrl.length > maxUrlLength) {
		throw new LinkError("URL_TOO_LONG");
	}

	let url: URL;

	try {
		url = new URL(trimmedUrl);
	} catch {
		throw new LinkError("INVALID_URL");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new LinkError("UNSUPPORTED_PROTOCOL");
	}

	const hostname = url.hostname.toLowerCase();

	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new LinkError("LOCAL_URL_NOT_ALLOWED");
	}

	if (isPrivateOrLocalHost(hostname)) {
		throw new LinkError("PRIVATE_IP_NOT_ALLOWED");
	}

	// Public IP literals are allowed; named hosts must look like a real domain
	// (have a dot and an alphabetic TLD) so that values like "ddd" are rejected.
	// This is purely structural — the server never resolves or fetches the host.
	if (!isIpLiteral(hostname) && !hasPublicTld(hostname)) {
		throw new LinkError("INVALID_DOMAIN");
	}

	return url;
}

function isIpLiteral(hostname: string) {
	if (hostname.startsWith("[")) {
		return true;
	}

	return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function hasPublicTld(hostname: string) {
	const labels = hostname.split(".");

	if (labels.length < 2 || labels.some((label) => label.length === 0)) {
		return false;
	}

	const tld = labels[labels.length - 1] ?? "";

	return /^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9]+$/.test(tld);
}

function isPrivateOrLocalHost(hostname: string) {
	const unwrappedHostname = hostname.replace(/^\[/, "").replace(/\]$/, "");

	return isPrivateIpv4(unwrappedHostname) || isPrivateIpv6(unwrappedHostname);
}

function isPrivateIpv4(hostname: string) {
	const parts = hostname.split(".");

	if (parts.length !== 4) {
		return false;
	}

	const octets = parts.map((part) => {
		if (!/^\d+$/.test(part)) {
			return Number.NaN;
		}

		const octet = Number(part);
		return octet >= 0 && octet <= 255 ? octet : Number.NaN;
	});

	if (octets.some(Number.isNaN)) {
		return false;
	}

	const [first = 0, second = 0] = octets;

	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168)
	);
}

function isPrivateIpv6(hostname: string) {
	if (!hostname.includes(":")) {
		return false;
	}

	const withoutZone = hostname.split("%")[0] ?? hostname;
	const ipv4Tail = withoutZone.split(":").at(-1);

	if (ipv4Tail && isPrivateIpv4(ipv4Tail)) {
		return true;
	}

	if (withoutZone === "::1" || /^0(?::0){0,7}:1$/.test(withoutZone)) {
		return true;
	}

	const firstGroup = withoutZone.split(":").find((group) => group.length > 0);

	if (!firstGroup || !/^[0-9a-f]{1,4}$/i.test(firstGroup)) {
		return false;
	}

	const firstValue = Number.parseInt(firstGroup, 16);

	return (firstValue & 0xfe00) === 0xfc00 || (firstValue & 0xffc0) === 0xfe80;
}
