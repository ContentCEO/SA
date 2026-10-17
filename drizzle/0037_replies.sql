ALTER TABLE "business_profile" ADD COLUMN "emergency_alerts_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "opening" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "emergency_alerted_at" timestamp with time zone;