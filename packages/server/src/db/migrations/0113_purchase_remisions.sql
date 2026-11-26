CREATE TABLE `purchase_remisions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`site_id` text NOT NULL,
	`purchase_id` text NOT NULL,
	`purchase_order_id` text,
	`number` text NOT NULL,
	`issued_at` text NOT NULL,
	`invoicing_status` text DEFAULT 'pending' NOT NULL,
	`payable_invoice_id` text,
	`received_by` text NOT NULL,
	`received_at` text NOT NULL,
	`notes` text,
	`sync_status` text DEFAULT 'pending',
	`sync_version` integer DEFAULT 1,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payable_invoice_id`) REFERENCES `provider_payable_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_purchase_remisions_number_present" CHECK(length(trim("purchase_remisions"."number")) > 0),
	CONSTRAINT "chk_purchase_remisions_invoicing_state" CHECK(("purchase_remisions"."invoicing_status" = 'invoiced' AND "purchase_remisions"."payable_invoice_id" IS NOT NULL) OR ("purchase_remisions"."invoicing_status" = 'pending' AND "purchase_remisions"."payable_invoice_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_purchase_remisions_tenant_provider_status` ON `purchase_remisions` (`tenant_id`,`provider_id`,`invoicing_status`);--> statement-breakpoint
CREATE INDEX `idx_purchase_remisions_tenant_created` ON `purchase_remisions` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_purchase_remisions_order` ON `purchase_remisions` (`purchase_order_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_remisions_invoice` ON `purchase_remisions` (`payable_invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_purchase_remisions_purchase` ON `purchase_remisions` (`purchase_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_purchase_remisions_provider_number` ON `purchase_remisions` (`tenant_id`,`provider_id`,`number`);--> statement-breakpoint
-- Adopt the purchases that already recorded a remisión number as a column
-- pair: from this migration onward the delivery note is an entity, and the
-- legacy label must not stay the only copy of that evidence.
--
-- The id must be a function of the row itself, never of the machine that ran
-- the migration: two devices applying this against the same purchase would
-- otherwise mint two identities for one delivery and, once synced, duplicate
-- the note (the same `prefix:...` shape the 0052/0059/0111 backfills use).
-- Historical remisiones carry no issue date of their own, so `issued_at` takes
-- the receipt date rather than inventing one. `OR IGNORE` is deliberate: the
-- legacy data had no uniqueness guarantee, so a provider that reused a number
-- keeps its first note instead of aborting the upgrade, and the unique index
-- above still prevents any new duplicate.
INSERT OR IGNORE INTO `purchase_remisions` (
	`id`,
	`tenant_id`,
	`provider_id`,
	`site_id`,
	`purchase_id`,
	`purchase_order_id`,
	`number`,
	`issued_at`,
	`invoicing_status`,
	`payable_invoice_id`,
	`received_by`,
	`received_at`,
	`notes`,
	`sync_status`,
	`sync_version`,
	`created_at`,
	`updated_at`
)
SELECT
	'legacy-remision:' || `tenant_id` || ':' || `id`,
	`tenant_id`,
	`provider_id`,
	`site_id`,
	`id`,
	`order_id`,
	trim(`document_number`),
	substr(`created_at`, 1, 10),
	'pending',
	NULL,
	`created_by`,
	`created_at`,
	NULL,
	'pending',
	1,
	`created_at`,
	`updated_at`
FROM `purchases`
WHERE `document_type` = 'remision'
	AND `document_number` IS NOT NULL
	AND length(trim(`document_number`)) > 0;
