ALTER TABLE "push_subscriptions" ADD COLUMN "fail_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "first_failed_at" timestamp with time zone;