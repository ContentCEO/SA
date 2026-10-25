ALTER TABLE "business_profile" ADD COLUMN "work_days" integer[] DEFAULT '{1,2,3,4,5,6}' NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "work_start_hour" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "work_end_hour" integer DEFAULT 18 NOT NULL;