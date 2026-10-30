import type { UrlxDb } from "@urlx/db";
import { generateSlug } from "../../lib/generate-slug";
import { validateSlug } from "../../lib/validate-slug";
import { validateDestinationUrl } from "../../lib/validate-url";
import { BioError } from "./bio.errors";
import type { BioRepository } from "./bio.repository";
import { BioRepository as Repository } from "./bio.repository";
import type {
	CheckBioSlugOutput,
	CreateBioInput,
	GetBioOutput,
	SearchBioInput,
	SearchBioOutput,
} from "./bio.schema";
import {
	defaultBioSearchPageSize,
	maxBioDescriptionLength,
	maxBioLinkLabelLength,
	maxBioLinks,
	maxBioSearchPageSize,
	maxBioSearchQueryLength,
	maxBioTitleLength,
} from "./bio.schema";
import type { NewBioLink, NewBioPage } from "./bio.types";

const maxSlugAttempts = 5;

export type BioServiceOptions = {
	db: UrlxDb;
	repository?: BioRepository;
};

export class BioService {
	private readonly repository: BioRepository;

	constructor(options: BioServiceOptions) {
		this.repository = options.repository ?? new Repository(options.db);
	}

	async createBioPage(input: CreateBioInput): Promise<{ slug: string }> {
		if (
			input.title.includes("\0") ||
			input.description?.includes("\0") ||
			input.slug?.includes("\0") ||
			input.links.some(
				(link) => link.label.includes("\0") || link.url.includes("\0"),
			)
		)
			throw new BioError("INVALID_TEXT");

		const title = input.title.trim();

		if (!title) {
			throw new BioError("EMPTY_TITLE");
		}

		if (title.length > maxBioTitleLength) {
			throw new BioError("TITLE_TOO_LONG");
		}

		const description = input.description?.trim() ?? "";

		if (description.length > maxBioDescriptionLength) {
			throw new BioError("DESCRIPTION_TOO_LONG");
		}

		if (input.links.length === 0) {
			throw new BioError("NO_LINKS");
		}

		if (input.links.length > maxBioLinks) {
			throw new BioError("TOO_MANY_LINKS");
		}

		const links = input.links.map((link) => {
			const label = link.label.trim();

			if (!label || label.length > maxBioLinkLabelLength) {
				throw new BioError("INVALID_LINK_LABEL");
			}

			// Reuses the shortener's destination validation: blocks non-http(s)
			// schemes, localhost, private/loopback IPs, and over-long URLs.
			validateDestinationUrl(link.url);

			return { label, url: link.url.trim() };
		});

		const requestedSlug = input.slug?.trim();
		const slug = requestedSlug
			? await this.claimCustomSlug(requestedSlug)
			: await this.claimGeneratedSlug();

		const now = Date.now();
		const pageId = crypto.randomUUID();
		const page: NewBioPage = {
			id: pageId,
			slug,
			title,
			description: description || null,
			createdAt: now,
			updatedAt: now,
			disabledAt: null,
		};

		const linkRows: NewBioLink[] = links.map((link, index) => ({
			id: crypto.randomUUID(),
			pageId,
			label: link.label,
			url: link.url,
			position: index,
			createdAt: now,
		}));

		try {
			await this.repository.createPageWithLinks(page, linkRows);
		} catch (error) {
			if (isSlugConflict(error)) {
				throw new BioError("SLUG_TAKEN");
			}

			throw new BioError("SERVER_ERROR");
		}

		return { slug };
	}

	async checkSlugAvailability(rawSlug: string): Promise<CheckBioSlugOutput> {
		const validation = validateSlug(rawSlug);

		if (!validation.ok) {
			return {
				slug: rawSlug.trim().toLowerCase(),
				available: false,
				reason: validation.reason,
			};
		}

		const exists = await this.repository.slugExists(validation.slug);

		return {
			slug: validation.slug,
			available: !exists,
			reason: exists ? "SLUG_TAKEN" : null,
		};
	}

	async searchBioPages(input: SearchBioInput): Promise<SearchBioOutput> {
		if (input.query?.includes("\0")) throw new BioError("INVALID_TEXT");
		const query = normalizeSearchQuery(input.query ?? "");
		const pageSize = clamp(
			input.pageSize ?? defaultBioSearchPageSize,
			1,
			maxBioSearchPageSize,
		);
		const requestedPage = Math.max(1, input.page ?? 1);

		const result = await this.repository.searchPages({
			query,
			limit: pageSize,
			page: requestedPage,
		});

		const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
		const page = Math.min(requestedPage, totalPages);

		return {
			query,
			page,
			pageSize,
			totalItems: result.total,
			totalPages,
			items: result.items,
		};
	}

	async getBioPage(rawSlug: string): Promise<GetBioOutput> {
		const slug = rawSlug.trim().toLowerCase();
		if (slug.includes("\0")) throw new BioError("PAGE_NOT_FOUND");
		const result = await this.repository.findBySlug(slug);

		if (!result || result.page.disabledAt !== null) {
			throw new BioError("PAGE_NOT_FOUND");
		}

		return {
			slug: result.page.slug,
			title: result.page.title,
			description: result.page.description,
			links: result.links.map((link) => ({
				label: link.label,
				url: link.url,
			})),
		};
	}

	private async claimCustomSlug(rawSlug: string) {
		const validation = validateSlug(rawSlug);

		if (!validation.ok) {
			throw new BioError(validation.reason);
		}

		if (await this.repository.slugExists(validation.slug)) {
			throw new BioError("SLUG_TAKEN");
		}

		return validation.slug;
	}

	private async claimGeneratedSlug() {
		for (let attempt = 0; attempt < maxSlugAttempts; attempt += 1) {
			const slug = generateSlug();

			if (!(await this.repository.slugExists(slug))) {
				return slug;
			}
		}

		throw new BioError("SERVER_ERROR");
	}
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function normalizeSearchQuery(rawQuery: string) {
	return rawQuery
		.trim()
		.replace(/^https?:\/\/[^/]+\/p\//i, "")
		.replace(/^\/?p\//i, "")
		.replace(/^@/, "")
		.slice(0, maxBioSearchQueryLength);
}

function isSlugConflict(error: unknown) {
	if (getErrorText(error).includes("bio_pages_slug")) return true;
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && !seen.has(current)) {
		seen.add(current);
		if (typeof current === "object" && "code" in current) {
			const code = (current as { code?: unknown }).code;
			const constraint =
				"constraint" in current
					? (current as { constraint?: unknown }).constraint
					: undefined;
			if (code === "23505" && constraint === "bio_pages_slug_unique")
				return true;
		}
		current =
			typeof current === "object" && "cause" in current
				? (current as { cause?: unknown }).cause
				: null;
	}
	return false;
}

function getErrorText(error: unknown) {
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
