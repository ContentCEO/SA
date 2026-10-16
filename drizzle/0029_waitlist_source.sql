ALTER TABLE "waitlist" ADD COLUMN "utm_source" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "utm_medium" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "referrer_host" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "confirmation_sent_at" timestamp with time zone;