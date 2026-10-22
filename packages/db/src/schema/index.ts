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

export const bioPages = sqliteTable(
	"bio_pages",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull(),
		title: text("title").notNull(),
		description: text("description"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		disabledAt: integer("disabled_at"),
	},
	(table) => [
		uniqueIndex("bio_pages_slug_unique").on(table.slug),
		index("bio_pages_created_at_idx").on(table.createdAt),
	],
);

export const bioLinks = sqliteTable(
	"bio_links",
	{
		id: text("id").primaryKey(),
		pageId: text("page_id").notNull(),
		label: text("label").notNull(),
		url: text("url").notNull(),
		position: integer("position").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [index("bio_links_page_id_idx").on(table.pageId)],
);

export const authUser = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" })
		.notNull()
		.default(false),
	image: text("image"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const authSession = sqliteTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		token: text("token").notNull().unique(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => authUser.id, { onDelete: "cascade" }),
	},
	(table) => [index("session_user_id_idx").on(table.userId)],
);

export const authAccount = sqliteTable(
	"account",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => authUser.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: integer("access_token_expires_at", {
			mode: "timestamp_ms",
		}),
		refreshTokenExpiresAt: integer("refresh_token_expires_at", {
			mode: "timestamp_ms",
		}),
		scope: text("scope"),
		password: text("password"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("account_user_id_idx").on(table.userId)],
);

export const authVerification = sqliteTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const forms = sqliteTable(
	"forms",
	{
		id: text("id").primaryKey(),
		ownerId: text("owner_id")
			.notNull()
			.references(() => authUser.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		description: text("description"),
		theme: text("theme").notNull().default("light"),
		accent: text("accent").notNull().default("blue"),
		confirmationMessage: text("confirmation_message"),
		slug: text("slug"),
		shortCode: text("short_code"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		disabledAt: integer("disabled_at"),
	},
	(table) => [
		index("forms_owner_updated_idx").on(table.ownerId, table.updatedAt),
		uniqueIndex("forms_slug_unique").on(table.slug),
		uniqueIndex("forms_short_code_unique").on(table.shortCode),
	],
);

export const formVersions = sqliteTable(
	"form_versions",
	{
		id: text("id").primaryKey(),
		formId: text("form_id")
			.notNull()
			.references(() => forms.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		fieldsJson: text("fields_json").notNull(),
		title: text("title").notNull(),
		description: text("description"),
		confirmationMessage: text("confirmation_message"),
		accent: text("accent").notNull().default("blue"),
		respondentAccess: text("respondent_access").notNull().default("public"),
		createdAt: integer("created_at").notNull(),
		publishedAt: integer("published_at"),
	},
	(table) => [
		uniqueIndex("form_versions_form_version_unique").on(
			table.formId,
			table.version,
		),
		index("form_versions_form_id_idx").on(table.formId),
	],
);

export const formLimits = sqliteTable("form_limits", {
	id: integer("id").primaryKey(),
	maxPublished: integer("max_published").notNull().default(25),
	maxMonthlyResponses: integer("max_monthly_responses").notNull().default(1000),
	maxRetainedResponses: integer("max_retained_responses")
		.notNull()
		.default(10000),
});

export const formAliases = sqliteTable(
	"form_aliases",
	{
		alias: text("alias").primaryKey(),
		formId: text("form_id")
			.notNull()
			.references(() => forms.id, { onDelete: "cascade" }),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [index("form_aliases_form_id_idx").on(table.formId)],
);

export const formAliasTombstones = sqliteTable("form_alias_tombstones", {
	alias: text("alias").primaryKey(),
	createdAt: integer("created_at").notNull(),
});

export const formResponses = sqliteTable(
	"form_responses",
	{
		id: text("id").primaryKey(),
		formId: text("form_id")
			.notNull()
			.references(() => forms.id, { onDelete: "cascade" }),
		versionId: text("version_id")
			.notNull()
			.references(() => formVersions.id, { onDelete: "cascade" }),
		idempotencyKey: text("idempotency_key").notNull(),
		answersJson: text("answers_json").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("form_responses_idempotency_unique").on(
			table.formId,
			table.idempotencyKey,
		),
		index("form_responses_form_created_idx").on(table.formId, table.createdAt),
	],
);

export const formMonthlyUsage = sqliteTable(
	"form_monthly_usage",
	{
		ownerId: text("owner_id")
			.notNull()
			.references(() => authUser.id, { onDelete: "cascade" }),
		month: text("month").notNull(),
		responseCount: integer("response_count").notNull().default(0),
	},
	(table) => [
		uniqueIndex("form_monthly_usage_owner_month_unique").on(
			table.ownerId,
			table.month,
		),
	],
);
