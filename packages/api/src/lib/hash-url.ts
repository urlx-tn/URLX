export async function hashUrl(normalizedUrl: string) {
	const encoded = new TextEncoder().encode(normalizedUrl);
	const digest = await crypto.subtle.digest("SHA-256", encoded);

	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
