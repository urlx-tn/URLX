CREATE TABLE `bio_links` (
	`id` text PRIMARY KEY NOT NULL,
	`page_id` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bio_links_page_id_idx` ON `bio_links` (`page_id`);--> statement-breakpoint
CREATE TABLE `bio_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bio_pages_slug_unique` ON `bio_pages` (`slug`);--> statement-breakpoint
CREATE INDEX `bio_pages_created_at_idx` ON `bio_pages` (`created_at`);