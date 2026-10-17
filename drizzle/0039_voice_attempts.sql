ALTER TABLE "voice_profile" ADD COLUMN "last_attempt" text;--> statement-breakpoint
ALTER TABLE "voice_profile" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_profile" ADD COLUMN "restart_count" integer DEFAULT 0 NOT NULL;