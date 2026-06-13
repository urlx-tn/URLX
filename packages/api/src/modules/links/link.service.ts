import { generateShortCode } from "../../lib/generate-code";
import { hashUrl } from "../../lib/hash-url";
import { normalizeUrl } from "../../lib/normalize-url";
import { validateDestinationUrl } from "../../lib/validate-url";
import { LinkError } from "./link.errors";
import type { LinkRepository, UrlxDb } from "./link.repository";
import { LinkRepository as Repository } from "./link.repository";
import type { Link } from "./link.types";

const maxInsertAttempts = 5;

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

				if (isShortCodeConflict(error)) {
					continue;
				}

				throw new LinkError("SERVER_ERROR");
			}
		}

		throw new LinkError("SERVER_ERROR");
	}

	private toShortenOutput(link: Pick<Link, "shortCode">) {
		return {
			shortCode: link.shortCode,
			shortUrl: `${this.shortUrlBase}/${link.shortCode}`,
		};
	}
}

function normalizeShortUrlBase(shortUrlBase: string) {
	return shortUrlBase.replace(/\/+$/, "");
}

function isUrlHashConflict(error: unknown) {
	return getErrorMessage(error).includes("url_hash");
}

function isShortCodeConflict(error: unknown) {
	return getErrorMessage(error).includes("short_code");
}

function getErrorMessage(error: unknown) {
	return error instanceof Error
		? error.message.toLowerCase()
		: String(error).toLowerCase();
}
