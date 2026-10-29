import { links, type UrlxDb } from "@urlx/db";
import { eq } from "drizzle-orm";

import type { NewLink } from "./link.types";

export type LinkDb = Pick<UrlxDb, "select" | "insert">;

export class LinkRepository {
	constructor(private readonly db: LinkDb) {}

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

	async createIfMissing(link: NewLink) {
		const inserted = await this.db
			.insert(links)
			.values(link)
			.onConflictDoNothing()
			.returning({ shortCode: links.shortCode });
		return inserted.length > 0;
	}
}
