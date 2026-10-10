ALTER TABLE "mailboxes" ADD COLUMN "last_sync_error_code" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "last_sync_error_at" timestamp with time zone;