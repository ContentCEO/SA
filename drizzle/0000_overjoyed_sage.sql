CREATE TYPE "public"."actor" AS ENUM('squared_away', 'owner');--> statement-breakpoint
CREATE TYPE "public"."mailbox_provider" AS ENUM('gmail');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('active', 'reconnect_needed', 'paused');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('solo', 'crew', 'company');--> statement-breakpoint
CREATE TYPE "public"."trade" AS ENUM('carpentry', 'plumbing', 'electrical', 'other');--> statement-breakpoint
CREATE TYPE "public"."workspace_status" AS ENUM('invited', 'evaluating', 'evaluation_expired', 'setup_paid', 'active', 'past_due', 'canceled', 'paused');--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor" "actor" NOT NULL,
	"action" text NOT NULL,
	"thread_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"email" text PRIMARY KEY NOT NULL,
	"trade" "trade",
	"note" text,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" "mailbox_provider" DEFAULT 'gmail' NOT NULL,
	"email" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"scopes" text NOT NULL,
	"history_id" text,
	"watch_expires_at" timestamp with time zone,
	"status" "mailbox_status" DEFAULT 'active' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"business_name" text,
	"trade" "trade",
	"status" "workspace_status" DEFAULT 'invited' NOT NULL,
	"evaluation_started_at" timestamp with time zone,
	"evaluation_ends_at" timestamp with time zone,
	"setup_paid_at" timestamp with time zone,
	"setup_call_completed_at" timestamp with time zone,
	"plan" "plan",
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_workspace_created_idx" ON "activity_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_workspace_email_uq" ON "mailboxes" USING btree ("workspace_id",lower("email"));--> statement-breakpoint
CREATE INDEX "mailboxes_workspace_idx" ON "mailboxes" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_owner_uq" ON "workspaces" USING btree ("owner_user_id");