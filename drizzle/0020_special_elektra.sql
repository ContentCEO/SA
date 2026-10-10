ALTER TABLE "drafts" ADD COLUMN "send_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "send_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "snoozed_until" timestamp with time zone;