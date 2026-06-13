CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`short_code` text NOT NULL,
	`original_url` text NOT NULL,
	`normalized_url` text NOT NULL,
	`url_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_short_code_unique` ON `links` (`short_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `links_url_hash_unique` ON `links` (`url_hash`);--> statement-breakpoint
CREATE INDEX `links_created_at_idx` ON `links` (`created_at`);