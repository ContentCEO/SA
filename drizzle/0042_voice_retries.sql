ALTER TABLE "voice_profile" ADD COLUMN "retry_day" text;--> statement-breakpoint
ALTER TABLE "voice_profile" ADD COLUMN "retries_that_day" integer DEFAULT 0 NOT NULL;