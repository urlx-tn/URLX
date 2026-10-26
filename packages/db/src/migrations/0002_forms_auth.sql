CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);
--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
--> statement-breakpoint
CREATE TABLE `forms` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`title` text NOT NULL,
	`description` text,
	`theme` text DEFAULT 'light' NOT NULL,
	`accent` text DEFAULT 'blue' NOT NULL,
	`confirmation_message` text,
	`slug` text,
	`short_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forms_slug_unique` ON `forms` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `forms_short_code_unique` ON `forms` (`short_code`);
--> statement-breakpoint
CREATE INDEX `forms_owner_updated_idx` ON `forms` (`owner_id`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `form_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL REFERENCES `forms`(`id`) ON DELETE CASCADE,
	`version` integer NOT NULL,
	`fields_json` text NOT NULL,
	`accent` text DEFAULT 'blue' NOT NULL,
	`created_at` integer NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_versions_form_version_unique` ON `form_versions` (`form_id`, `version`);
--> statement-breakpoint
CREATE INDEX `form_versions_form_id_idx` ON `form_versions` (`form_id`);
--> statement-breakpoint
CREATE TABLE `form_aliases` (
	`alias` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL REFERENCES `forms`(`id`) ON DELETE CASCADE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `form_aliases_form_id_idx` ON `form_aliases` (`form_id`);
--> statement-breakpoint
CREATE TABLE `form_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL REFERENCES `forms`(`id`) ON DELETE CASCADE,
	`version_id` text NOT NULL REFERENCES `form_versions`(`id`) ON DELETE CASCADE,
	`idempotency_key` text NOT NULL,
	`answers_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_responses_idempotency_unique` ON `form_responses` (`form_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `form_responses_form_created_idx` ON `form_responses` (`form_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `form_monthly_usage` (
	`owner_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`month` text NOT NULL,
	`response_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY (`owner_id`, `month`)
);
--> statement-breakpoint
CREATE TRIGGER `form_responses_quota_and_retention_before_insert`
BEFORE INSERT ON `form_responses`
WHEN NOT EXISTS (
	SELECT 1 FROM form_responses WHERE form_id = NEW.form_id AND idempotency_key = NEW.idempotency_key
)
BEGIN
	SELECT CASE WHEN (
		SELECT COALESCE(response_count, 0)
		FROM form_monthly_usage
		WHERE owner_id = (SELECT owner_id FROM forms WHERE id = NEW.form_id)
			AND month = strftime('%Y-%m', NEW.created_at / 1000, 'unixepoch')
	) >= 1000 THEN RAISE(ABORT, 'forms_owner_monthly_quota') END;
	DELETE FROM form_responses
	WHERE id IN (
		SELECT response.id
		FROM form_responses AS response
		JOIN forms AS response_form ON response_form.id = response.form_id
		WHERE response_form.owner_id = (SELECT owner_id FROM forms WHERE id = NEW.form_id)
		ORDER BY response.created_at ASC, response.id ASC
		LIMIT 1
	)
	AND (
		SELECT COUNT(*) FROM form_responses AS response
		JOIN forms AS response_form ON response_form.id = response.form_id
		WHERE response_form.owner_id = (SELECT owner_id FROM forms WHERE id = NEW.form_id)
	) >= 10000;
END;
--> statement-breakpoint
CREATE TRIGGER `form_responses_usage_after_insert`
AFTER INSERT ON `form_responses`
WHEN NOT EXISTS (
	SELECT 1 FROM form_responses WHERE form_id = NEW.form_id AND idempotency_key = NEW.idempotency_key AND id <> NEW.id
)
BEGIN
	INSERT INTO form_monthly_usage (owner_id, month, response_count)
	SELECT owner_id, strftime('%Y-%m', NEW.created_at / 1000, 'unixepoch'), 1
	FROM forms WHERE id = NEW.form_id
	ON CONFLICT(owner_id, month) DO UPDATE SET response_count = response_count + 1;
END;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE `form_versions` ADD COLUMN `title` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `form_versions` ADD COLUMN `description` text;
--> statement-breakpoint
ALTER TABLE `form_versions` ADD COLUMN `confirmation_message` text;
--> statement-breakpoint
UPDATE `form_versions` SET `title` = (SELECT `title` FROM `forms` WHERE `forms`.`id` = `form_versions`.`form_id`), `description` = (SELECT `description` FROM `forms` WHERE `forms`.`id` = `form_versions`.`form_id`), `confirmation_message` = (SELECT `confirmation_message` FROM `forms` WHERE `forms`.`id` = `form_versions`.`form_id`);
--> statement-breakpoint
CREATE TABLE `form_limits` (`id` integer PRIMARY KEY NOT NULL, `max_published` integer DEFAULT 25 NOT NULL, `max_monthly_responses` integer DEFAULT 1000 NOT NULL, `max_retained_responses` integer DEFAULT 10000 NOT NULL);
--> statement-breakpoint
INSERT INTO `form_limits` (`id`, `max_published`, `max_monthly_responses`, `max_retained_responses`) VALUES (1, 25, 1000, 10000);
--> statement-breakpoint
DROP TRIGGER `form_responses_quota_and_retention_before_insert`;
--> statement-breakpoint
CREATE TRIGGER `forms_published_cap_before_update`
BEFORE UPDATE OF `published_at` ON `form_versions`
WHEN OLD.`published_at` IS NULL AND NEW.`published_at` IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM form_versions WHERE form_id=NEW.form_id AND published_at IS NOT NULL)
BEGIN
 SELECT CASE WHEN (
  SELECT COUNT(DISTINCT f.id) FROM forms f JOIN form_versions v ON v.form_id=f.id WHERE f.owner_id=(SELECT owner_id FROM forms WHERE id=NEW.form_id) AND f.disabled_at IS NULL AND v.published_at IS NOT NULL
 ) >= (SELECT max_published FROM form_limits WHERE id=1)
 THEN RAISE(ABORT, 'forms_owner_published_limit') END;
END;
--> statement-breakpoint
CREATE TRIGGER `form_responses_quota_and_retention_before_insert`
BEFORE INSERT ON `form_responses`
WHEN NOT EXISTS (SELECT 1 FROM form_responses WHERE form_id=NEW.form_id AND idempotency_key=NEW.idempotency_key)
BEGIN
 SELECT CASE WHEN (
  SELECT COALESCE(response_count,0) FROM form_monthly_usage
  WHERE owner_id=(SELECT owner_id FROM forms WHERE id=NEW.form_id) AND month=strftime('%Y-%m', NEW.created_at / 1000, 'unixepoch')
 ) >= (SELECT max_monthly_responses FROM form_limits WHERE id=1)
 THEN RAISE(ABORT, 'forms_owner_monthly_quota') END;
 DELETE FROM form_responses WHERE id IN (
  SELECT response.id FROM form_responses AS response JOIN forms AS response_form ON response_form.id=response.form_id
  WHERE response_form.owner_id=(SELECT owner_id FROM forms WHERE id=NEW.form_id)
  ORDER BY response.created_at ASC,response.id ASC LIMIT 1
 ) AND (SELECT COUNT(*) FROM form_responses AS response JOIN forms AS response_form ON response_form.id=response.form_id WHERE response_form.owner_id=(SELECT owner_id FROM forms WHERE id=NEW.form_id)) >= (SELECT max_retained_responses FROM form_limits WHERE id=1);
END;
--> statement-breakpoint
CREATE TRIGGER `form_responses_open_version_before_insert`
BEFORE INSERT ON `form_responses`
WHEN (SELECT `disabled_at` FROM `forms` WHERE `id`=NEW.`form_id`) IS NOT NULL
 OR (SELECT `published_at` FROM `form_versions` WHERE `id`=NEW.`version_id` AND `form_id`=NEW.`form_id`) IS NULL
BEGIN
 SELECT RAISE(ABORT, 'forms_collection_closed');
END;
--> statement-breakpoint
CREATE TABLE `form_alias_tombstones` (`alias` text PRIMARY KEY NOT NULL, `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE TRIGGER `forms_alias_tombstones_before_delete`
BEFORE DELETE ON `forms`
BEGIN
 INSERT OR IGNORE INTO `form_alias_tombstones` (`alias`, `created_at`)
 SELECT `alias`, `created_at` FROM `form_aliases` WHERE `form_id`=OLD.`id`;
END;
