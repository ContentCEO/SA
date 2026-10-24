ALTER TABLE "business_profile" ADD COLUMN "sms_summary_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "sms_summary_last_sent_on" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "sms_at_risk_enabled" boolean DEFAULT false NOT NULL;