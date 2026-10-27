import {
	bigint,
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const links = pgTable(
	"links",
	{
		id: text("id").primaryKey(),
		shortCode: text("short_code").notNull(),
		originalUrl: text("original_url").notNull(),
		normalizedUrl: text("normalized_url").notNull(),
		urlHash: text("url_hash").notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
		disabledAt: bigint("disabled_at", { mode: "number" }),
	},
	(table) => [
		uniqueIndex("links_short_code_unique").on(table.shortCode),
		uniqueIndex("links_url_hash_unique").on(table.urlHash),
		index("links_created_at_idx").on(table.createdAt),
	],
);

export const bioPages = pgTable(
	"bio_pages",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull(),
		title: text("title").notNull(),
		description: text("description"),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
		disabledAt: bigint("disabled_at", { mode: "number" }),
	},
	(table) => [
		uniqueIndex("bio_pages_slug_unique").on(table.slug),
		index("bio_pages_created_at_idx").on(table.createdAt),
	],
);

export const bioLinks = pgTable(
	"bio_links",
	{
		id: text("id").primaryKey(),
		pageId: text("page_id").notNull(),
		label: text("label").notNull(),
		url: text("url").notNull(),
		position: integer("position").notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [index("bio_links_page_id_idx").on(table.pageId)],
);

export const authUser = pgTable(
	"user",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		email: text("email").notNull(),
		emailVerified: boolean("email_verified").notNull().default(false),
		image: text("image"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
	},
	(table) => [uniqueIndex("user_email_unique").on(table.email)],
);

export const authSession = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		token: text("token").notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => authUser.id, { onDelete: "cascade" }),
	},
	(table) => [
		uniqueIndex("session_token_unique").on(table.token),
		index("session_user_id_idx").on(table.userId),
	],
);

export const authAccount = pgTable(
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
		accessTokenExpiresAt: timestamp("access_token_expires_at", {
			withTimezone: true,
			mode: "date",
		}),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
			withTimezone: true,
			mode: "date",
		}),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
	},
	(table) => [index("account_user_id_idx").on(table.userId)],
);

export const authVerification = pgTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const forms = pgTable(
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
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
		disabledAt: bigint("disabled_at", { mode: "number" }),
	},
	(table) => [
		index("forms_owner_updated_idx").on(table.ownerId, table.updatedAt),
		uniqueIndex("forms_slug_unique").on(table.slug),
		uniqueIndex("forms_short_code_unique").on(table.shortCode),
	],
);

export const formVersions = pgTable(
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
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		publishedAt: bigint("published_at", { mode: "number" }),
	},
	(table) => [
		uniqueIndex("form_versions_form_version_unique").on(
			table.formId,
			table.version,
		),
		index("form_versions_form_id_idx").on(table.formId),
	],
);

export const formLimits = pgTable("form_limits", {
	id: integer("id").primaryKey(),
	maxPublished: integer("max_published").notNull().default(25),
	maxMonthlyResponses: integer("max_monthly_responses").notNull().default(1000),
	maxRetainedResponses: integer("max_retained_responses")
		.notNull()
		.default(10000),
});

export const formOwnerLocks = pgTable("form_owner_locks", {
	ownerId: text("owner_id")
		.primaryKey()
		.references(() => authUser.id, { onDelete: "cascade" }),
});

export const formAliases = pgTable(
	"form_aliases",
	{
		alias: text("alias").primaryKey(),
		formId: text("form_id")
			.notNull()
			.references(() => forms.id, { onDelete: "cascade" }),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [index("form_aliases_form_id_idx").on(table.formId)],
);

export const formAliasLocks = pgTable("form_alias_locks", {
	alias: text("alias").primaryKey(),
});

export const formAliasTombstones = pgTable("form_alias_tombstones", {
	alias: text("alias").primaryKey(),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const formResponses = pgTable(
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
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("form_responses_idempotency_unique").on(
			table.formId,
			table.idempotencyKey,
		),
		index("form_responses_form_created_idx").on(table.formId, table.createdAt),
	],
);

export const formMonthlyUsage = pgTable(
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
