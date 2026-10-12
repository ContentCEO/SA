CREATE TABLE "referral_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referred_workspace_id" uuid,
	"referred_email_sha256" text NOT NULL,
	"beneficiary_workspace_id" uuid,
	"side" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_balance_transaction_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "referred_by_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "referred_by_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD CONSTRAINT "referral_credits_referred_workspace_id_workspaces_id_fk" FOREIGN KEY ("referred_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_credits" ADD CONSTRAINT "referral_credits_beneficiary_workspace_id_workspaces_id_fk" FOREIGN KEY ("beneficiary_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_credits_email_side_uq" ON "referral_credits" USING btree ("referred_email_sha256","side");--> statement-breakpoint
CREATE INDEX "referral_credits_status_idx" ON "referral_credits" USING btree ("status");--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_referred_by_workspace_id_workspaces_id_fk" FOREIGN KEY ("referred_by_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_referred_by_workspace_id_workspaces_id_fk" FOREIGN KEY ("referred_by_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_referral_code_uq" ON "workspaces" USING btree ("referral_code");