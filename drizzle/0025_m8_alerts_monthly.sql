ALTER TABLE "business_profile" ADD COLUMN "monthly_summary_last_sent_for" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "quote_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "job_kind" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "at_risk_alerted_at" timestamp with time zone;