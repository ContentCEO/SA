ALTER TABLE "mailboxes" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "reward" text DEFAULT 'balance_credit' NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "stripe_mode" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "stripe_coupon_id" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "stripe_discount_id" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "stripe_invoice_id" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "attached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "invoice_final_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "plan_change_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "paid_plan" "plan";--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "paid_price_id" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "paid_price_cents" integer;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "free_plan" "plan";--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "kept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "kept_price_cents" integer;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "billing_mode" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "admin_flag" text;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD COLUMN "flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "free_plan" "plan";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "free_plan_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "stripe_cancel_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_credits_one_scheduled_uq" ON "referral_credits" USING btree ("beneficiary_workspace_id") WHERE status = 'scheduled';--> statement-breakpoint
CREATE UNIQUE INDEX "referral_credits_one_running_uq" ON "referral_credits" USING btree ("beneficiary_workspace_id") WHERE status = 'running';