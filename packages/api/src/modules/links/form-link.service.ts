import { generateShortCode } from "../../lib/generate-code";
import { hashUrl } from "../../lib/hash-url";
import { normalizeUrl } from "../../lib/normalize-url";
import { LinkError } from "./link.errors";
import { type LinkDb, LinkRepository } from "./link.repository";
import type { Link } from "./link.types";

const maxInsertAttempts = 5;

/**
 * Create the first-party respondent link for a validated form slug.
 * The host comes only from deployment configuration; unlike user destinations,
 * it is intentionally allowed to be loopback or another private address.
 */
export async function createFirstPartyFormLink(
	db: LinkDb,
	configuredOrigin: string,
	slug: string,
) {
	if (!/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/.test(slug))
		throw new Error("Invalid form slug for first-party link");
	const origin = normalizeTrustedOrigin(configuredOrigin);
	const originalUrl = new URL(
		`/f/${encodeURIComponent(slug)}`,
		origin,
	).toString();
	const normalizedUrl = normalizeUrl(originalUrl);
	const urlHash = await hashUrl(normalizedUrl);
	const repository = new LinkRepository(db);
	const existing = await repository.findByUrlHash(urlHash);
	if (existing) return existing.shortCode;

	for (let attempt = 0; attempt < maxInsertAttempts; attempt += 1) {
		const now = Date.now();
		const link: Link = {
			id: crypto.randomUUID(),
			shortCode: generateShortCode(),
			originalUrl,
			normalizedUrl,
			urlHash,
			createdAt: now,
			updatedAt: now,
			disabledAt: null,
		};

		if (await repository.createIfMissing(link)) return link.shortCode;
		const duplicate = await repository.findByUrlHash(urlHash);
		if (duplicate) return duplicate.shortCode;
		// A different link already owns the generated short code. The conflict
		// was handled by ON CONFLICT, so the surrounding transaction remains live.
	}

	throw new LinkError("SERVER_ERROR");
}

export function normalizeTrustedOrigin(configuredOrigin: string) {
	let url: URL;
	try {
		url = new URL(configuredOrigin);
	} catch {
		throw new Error("Invalid configured first-party origin");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("Invalid configured first-party origin");
	return url.origin;
}
