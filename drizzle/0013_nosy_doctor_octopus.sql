ALTER TABLE "business_profile" ADD COLUMN "alert_phone" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "alert_phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "sms_code_hash" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "sms_code_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "sms_alerts_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "sms_alert_cursor" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "sms_last_sent_at" timestamp with time zone;