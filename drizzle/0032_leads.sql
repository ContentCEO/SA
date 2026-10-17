ALTER TABLE "business_profile" ADD COLUMN "service_towns" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "lead_channel" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "complaint_fixed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "complaint_checkin_done_at" timestamp with time zone;