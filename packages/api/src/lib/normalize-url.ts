export function normalizeUrl(rawUrl: string) {
	const url = new URL(rawUrl.trim());

	url.protocol = url.protocol.toLowerCase();
	url.hostname = url.hostname.toLowerCase();

	if (
		(url.protocol === "http:" && url.port === "80") ||
		(url.protocol === "https:" && url.port === "443")
	) {
		url.port = "";
	}

	return url.toString();
}
