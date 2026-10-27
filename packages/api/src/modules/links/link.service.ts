import type { UrlxDb } from "@urlx/db";
import { generateShortCode } from "../../lib/generate-code";
import { hashUrl } from "../../lib/hash-url";
import { normalizeUrl } from "../../lib/normalize-url";
import { validateDestinationUrl } from "../../lib/validate-url";
import { LinkError } from "./link.errors";
import type { LinkRepository } from "./link.repository";
import { LinkRepository as Repository } from "./link.repository";
import type { GetLinkOutput } from "./link.schema";
import type { Link } from "./link.types";

const maxInsertAttempts = 5;
const shortUrlPrefix = "/u";

export type LinkServiceOptions = {
	db: UrlxDb;
	shortUrlBase: string;
	repository?: LinkRepository;
};

export class LinkService {
	private readonly repository: LinkRepository;
	private readonly shortUrlBase: string;

	constructor(options: LinkServiceOptions) {
		this.repository = options.repository ?? new Repository(options.db);
		this.shortUrlBase = normalizeShortUrlBase(options.shortUrlBase);
	}

	async shorten(rawUrl: string) {
		validateDestinationUrl(rawUrl);

		const originalUrl = rawUrl.trim();
		const normalizedUrl = normalizeUrl(originalUrl);
		const urlHash = await hashUrl(normalizedUrl);
		const existingLink = await this.repository.findByUrlHash(urlHash);

		if (existingLink) {
			return this.toShortenOutput(existingLink);
		}

		for (let attempt = 0; attempt < maxInsertAttempts; attempt += 1) {
			const shortCode = generateShortCode();
			const now = Date.now();
			const link: Link = {
				id: crypto.randomUUID(),
				shortCode,
				originalUrl,
				normalizedUrl,
				urlHash,
				createdAt: now,
				updatedAt: now,
				disabledAt: null,
			};

			try {
				await this.repository.create(link);
				return this.toShortenOutput(link);
			} catch (error) {
				if (isUrlHashConflict(error)) {
					const duplicateLink = await this.repository.findByUrlHash(urlHash);

					if (duplicateLink) {
						return this.toShortenOutput(duplicateLink);
					}
				}

				if (
					isShortCodeConflict(error) ||
					isPgConstraint(error, "links_short_code_unique")
				) {
					continue;
				}

				throw new LinkError("SERVER_ERROR");
			}
		}

		throw new LinkError("SERVER_ERROR");
	}

	async getByShortCode(shortCode: string): Promise<GetLinkOutput> {
		const link = await this.repository.findByShortCode(shortCode);

		if (!link || link.disabledAt !== null) {
			throw new LinkError("SHORT_CODE_NOT_FOUND");
		}

		return { originalUrl: link.originalUrl };
	}

	private toShortenOutput(link: Pick<Link, "shortCode">) {
		return {
			shortCode: link.shortCode,
			shortUrl: `${this.shortUrlBase}${shortUrlPrefix}/${link.shortCode}`,
		};
	}
}

function normalizeShortUrlBase(shortUrlBase: string) {
	return shortUrlBase.replace(/\/+$/, "");
}

function isUrlHashConflict(error: unknown) {
	return (
		getErrorMessage(error).includes("url_hash") ||
		isPgConstraint(error, "links_url_hash_unique")
	);
}

function isShortCodeConflict(error: unknown) {
	return getErrorMessage(error).includes("short_code");
}

function isPgConstraint(error: unknown, expected: string) {
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && !seen.has(current)) {
		seen.add(current);
		if (typeof current === "object" && "constraint" in current) {
			const constraint = (current as { constraint?: unknown }).constraint;
			const code =
				"code" in current ? (current as { code?: unknown }).code : undefined;
			if (code === "23505" && constraint === expected) return true;
		}
		current =
			typeof current === "object" && "cause" in current
				? (current as { cause?: unknown }).cause
				: null;
	}
	return false;
}

function getErrorMessage(error: unknown) {
	let current: unknown = error;
	const seen = new Set<unknown>();
	let message = "";
	while (current && !seen.has(current)) {
		seen.add(current);
		message += ` ${current instanceof Error ? current.message : String(current)}`;
		current =
			typeof current === "object" && "cause" in current
				? (current as { cause?: unknown }).cause
				: null;
	}
	return message.toLowerCase();
}
