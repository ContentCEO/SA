ALTER TABLE "business_profile" ADD COLUMN "reply_languages" text[] DEFAULT '{"en"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "customer_language" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "reply_language" text;