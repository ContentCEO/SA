ALTER TABLE "business_profile" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "crew_addresses" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "auto_reply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ack_only" boolean DEFAULT false NOT NULL;