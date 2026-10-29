/** Shared IP/URL safety checks for the native preview proxy and renderer. */
export function isUnsafeRequestUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return true;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return true;
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (
		!hostname ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		(!hostname.includes(":") && !hostname.includes("."))
	)
		return true;
	return isBlockedIpLiteral(hostname);
}

export function isUnsafePublicIpv4Address(address: string): boolean {
	return !isGlobalIpv4(address);
}

function isBlockedIpLiteral(hostname: string): boolean {
	if (/^\d+(?:\.\d+){3}$/.test(hostname)) return !isGlobalIpv4(hostname);
	if (!hostname.includes(":")) return false;
	const address = parseIpv6(hostname);
	if (address === null) return true;
	const globalUnicast = address >> 125n === 1n; // 2000::/3
	if (!globalUnicast) return true;
	return (
		inIpv6Cidr(address, "2001::", 23) ||
		inIpv6Cidr(address, "2001:db8::", 32) ||
		inIpv6Cidr(address, "2002::", 16)
	);
}

function isGlobalIpv4(value: string): boolean {
	const parts = value.split(".").map(Number);
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	)
		return false;
	const address =
		(BigInt(parts[0] ?? 0) << 24n) |
		(BigInt(parts[1] ?? 0) << 16n) |
		(BigInt(parts[2] ?? 0) << 8n) |
		BigInt(parts[3] ?? 0);
	const blocked: Array<[string, number]> = [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.88.99.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
		["255.255.255.255", 32],
	];
	return !blocked.some(([network, prefix]) =>
		inIpv4Cidr(address, network, prefix),
	);
}

function inIpv4Cidr(address: bigint, network: string, prefix: number) {
	const parts = network.split(".").map(Number);
	const networkAddress =
		(BigInt(parts[0] ?? 0) << 24n) |
		(BigInt(parts[1] ?? 0) << 16n) |
		(BigInt(parts[2] ?? 0) << 8n) |
		BigInt(parts[3] ?? 0);
	const shift = BigInt(32 - prefix);
	return address >> shift === networkAddress >> shift;
}

function parseIpv6(value: string): bigint | null {
	let normalized = value.toLowerCase();
	if (normalized.includes("%")) return null;
	if (normalized.includes(".")) {
		const splitAt = normalized.lastIndexOf(":");
		const ipv4 = normalized.slice(splitAt + 1);
		if (!/^\d+(?:\.\d+){3}$/.test(ipv4)) return null;
		const parts = ipv4.split(".").map(Number);
		if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
			return null;
		const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
		const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
		normalized = `${normalized.slice(0, splitAt)}:${high.toString(16)}:${low.toString(16)}`;
	}
	const halves = normalized.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (
		(halves.length === 1 && missing !== 0) ||
		(halves.length === 2 && missing < 1)
	)
		return null;
	const groups = [
		...left,
		...Array.from({ length: missing }, () => "0"),
		...right,
	];
	if (
		groups.length !== 8 ||
		groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
	)
		return null;
	return groups.reduce(
		(address, group) => (address << 16n) | BigInt(`0x${group}`),
		0n,
	);
}

function inIpv6Cidr(address: bigint, network: string, prefix: number) {
	const parsed = parseIpv6(network);
	if (parsed === null) return false;
	const shift = BigInt(128 - prefix);
	return address >> shift === parsed >> shift;
}
