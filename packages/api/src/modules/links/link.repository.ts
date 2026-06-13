import type { createDb } from "@urlx/db";
import { links } from "@urlx/db";
import { eq } from "drizzle-orm";

import type { NewLink } from "./link.types";

export type UrlxDb = ReturnType<typeof createDb>;

export class LinkRepository {
	constructor(private readonly db: UrlxDb) {}

	async findByUrlHash(urlHash: string) {
		const [link] = await this.db
			.select()
			.from(links)
			.where(eq(links.urlHash, urlHash))
			.limit(1);
		return link;
	}

	async findByShortCode(shortCode: string) {
		const [link] = await this.db
			.select()
			.from(links)
			.where(eq(links.shortCode, shortCode))
			.limit(1);

		return link;
	}

	async create(link: NewLink) {
		await this.db.insert(links).values(link);
		return link;
	}
}
