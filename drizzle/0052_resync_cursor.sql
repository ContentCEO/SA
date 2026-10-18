ALTER TABLE "mailboxes" ADD COLUMN "resync_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "resync_page_token" text;