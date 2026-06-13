import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const links = sqliteTable(
	"links",
	{
		id: text("id").primaryKey(),
		shortCode: text("short_code").notNull(),
		originalUrl: text("original_url").notNull(),
		normalizedUrl: text("normalized_url").notNull(),
		urlHash: text("url_hash").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		disabledAt: integer("disabled_at"),
	},
	(table) => [
		uniqueIndex("links_short_code_unique").on(table.shortCode),
		uniqueIndex("links_url_hash_unique").on(table.urlHash),
		index("links_created_at_idx").on(table.createdAt),
	],
);
