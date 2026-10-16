ALTER TABLE "business_profile" ADD COLUMN "first_look_hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "test_user_added_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "handled_offline_at" timestamp with time zone;