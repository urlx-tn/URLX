import type { createDb } from "@urlx/db";
import { bioLinks, bioPages } from "@urlx/db";
import { and, asc, count, desc, eq, isNull, or, sql } from "drizzle-orm";

import type { NewBioLink, NewBioPage } from "./bio.types";

export type UrlxDb = ReturnType<typeof createDb>;

export class BioRepository {
	constructor(private readonly db: UrlxDb) {}

	async slugExists(slug: string) {
		const [page] = await this.db
			.select({ id: bioPages.id })
			.from(bioPages)
			.where(eq(bioPages.slug, slug))
			.limit(1);

		return Boolean(page);
	}

	async createPageWithLinks(page: NewBioPage, links: NewBioLink[]) {
		await this.db.batch([
			this.db.insert(bioPages).values(page),
			...links.map((link) => this.db.insert(bioLinks).values(link)),
		]);

		return page;
	}

	async searchPages(options: { query: string; limit: number; offset: number }) {
		const where = buildSearchWhere(options.query);
		const orderBy = buildSearchOrder(options.query);

		const [totalRows, items] = await Promise.all([
			this.db.select({ total: count() }).from(bioPages).where(where),
			this.db
				.select({
					slug: bioPages.slug,
					title: bioPages.title,
					description: bioPages.description,
					createdAt: bioPages.createdAt,
				})
				.from(bioPages)
				.where(where)
				.orderBy(...orderBy)
				.limit(options.limit)
				.offset(options.offset),
		]);

		return {
			total: Number(totalRows[0]?.total ?? 0),
			items,
		};
	}

	async findBySlug(slug: string) {
		const [page] = await this.db
			.select()
			.from(bioPages)
			.where(eq(bioPages.slug, slug))
			.limit(1);

		if (!page) {
			return undefined;
		}

		const links = await this.db
			.select()
			.from(bioLinks)
			.where(eq(bioLinks.pageId, page.id))
			.orderBy(asc(bioLinks.position));

		return { page, links };
	}
}

function buildSearchWhere(query: string) {
	const trimmed = query.trim().toLowerCase();

	if (!trimmed) {
		return isNull(bioPages.disabledAt);
	}

	const pattern = `%${escapeLikePattern(trimmed)}%`;
	const matchesQuery = or(
		sql`lower(${bioPages.title}) like ${pattern} escape '\\'`,
		sql`lower(${bioPages.slug}) like ${pattern} escape '\\'`,
	);

	return and(isNull(bioPages.disabledAt), matchesQuery);
}

function buildSearchOrder(query: string) {
	const trimmed = query.trim().toLowerCase();

	if (!trimmed) {
		return [desc(bioPages.createdAt), asc(bioPages.slug)];
	}

	const prefix = `${escapeLikePattern(trimmed)}%`;

	const rank = sql`
		case
			when lower(${bioPages.slug}) = ${trimmed} then 0
			when lower(${bioPages.title}) = ${trimmed} then 1
			when lower(${bioPages.slug}) like ${prefix} escape '\\' then 2
			when lower(${bioPages.title}) like ${prefix} escape '\\' then 3
			else 4
		end
	`;

	return [rank, desc(bioPages.createdAt), asc(bioPages.slug)];
}

function escapeLikePattern(value: string) {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
