ALTER TABLE "mailboxes" ADD COLUMN "backfill_page_token" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "backfill_pages_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "backfill_since" timestamp with time zone;