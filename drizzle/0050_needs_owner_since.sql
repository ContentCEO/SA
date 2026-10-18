ALTER TABLE "threads" ADD COLUMN "needs_owner_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "quote_dismissed_at" timestamp with time zone;