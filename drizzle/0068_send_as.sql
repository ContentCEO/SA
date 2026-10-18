ALTER TABLE "drafts" ADD COLUMN "from_address" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "send_as" text[] DEFAULT '{}'::text[] NOT NULL;