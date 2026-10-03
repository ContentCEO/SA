ALTER TABLE "business_profile" ADD COLUMN "digest_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "digest_hour" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "time_zone" text DEFAULT 'America/New_York' NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "digest_last_sent_on" text;