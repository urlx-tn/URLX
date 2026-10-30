CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bio_links" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bio_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"disabled_at" bigint
);
--> statement-breakpoint
CREATE TABLE "form_alias_tombstones" (
	"alias" text PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_limits" (
	"id" integer PRIMARY KEY NOT NULL,
	"max_published" integer DEFAULT 25 NOT NULL,
	"max_monthly_responses" integer DEFAULT 1000 NOT NULL,
	"max_retained_responses" integer DEFAULT 10000 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_monthly_usage" (
	"owner_id" text NOT NULL,
	"month" text NOT NULL,
	"response_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_owner_locks" (
	"owner_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"version_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"answers_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"version" integer NOT NULL,
	"fields_json" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"confirmation_message" text,
	"accent" text DEFAULT 'blue' NOT NULL,
	"respondent_access" text DEFAULT 'public' NOT NULL,
	"created_at" bigint NOT NULL,
	"published_at" bigint
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"theme" text DEFAULT 'light' NOT NULL,
	"accent" text DEFAULT 'blue' NOT NULL,
	"confirmation_message" text,
	"slug" text,
	"short_code" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"disabled_at" bigint
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" text PRIMARY KEY NOT NULL,
	"short_code" text NOT NULL,
	"original_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"url_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"disabled_at" bigint
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_aliases" ADD CONSTRAINT "form_aliases_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_monthly_usage" ADD CONSTRAINT "form_monthly_usage_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_owner_locks" ADD CONSTRAINT "form_owner_locks_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_version_id_form_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."form_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "bio_links_page_id_idx" ON "bio_links" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bio_pages_slug_unique" ON "bio_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "bio_pages_created_at_idx" ON "bio_pages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "form_aliases_form_id_idx" ON "form_aliases" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_monthly_usage_owner_month_unique" ON "form_monthly_usage" USING btree ("owner_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "form_responses_idempotency_unique" ON "form_responses" USING btree ("form_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "form_responses_form_created_idx" ON "form_responses" USING btree ("form_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_form_version_unique" ON "form_versions" USING btree ("form_id","version");--> statement-breakpoint
CREATE INDEX "form_versions_form_id_idx" ON "form_versions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "forms_owner_updated_idx" ON "forms" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_slug_unique" ON "forms" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_short_code_unique" ON "forms" USING btree ("short_code");--> statement-breakpoint
CREATE UNIQUE INDEX "links_short_code_unique" ON "links" USING btree ("short_code");--> statement-breakpoint
CREATE UNIQUE INDEX "links_url_hash_unique" ON "links" USING btree ("url_hash");--> statement-breakpoint
CREATE INDEX "links_created_at_idx" ON "links" USING btree ("created_at");