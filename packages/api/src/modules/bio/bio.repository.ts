import type { createDb } from "@urlx/db";
import { bioLinks, bioPages } from "@urlx/db";
import { asc, eq } from "drizzle-orm";

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
