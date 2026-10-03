CREATE TYPE "public"."voice_source" AS ENUM('learned', 'edited');--> statement-breakpoint
CREATE TYPE "public"."voice_status" AS ENUM('learning', 'ready', 'not_enough_mail', 'failed');--> statement-breakpoint
CREATE TABLE "business_profile" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"services" text,
	"service_area" text,
	"hours" text,
	"lead_time" text,
	"pricing_notes" text,
	"payment_terms" text,
	"policies" text,
	"signature" text,
	"do_not_promise" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vip_senders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_threshold_dollars" integer DEFAULT 2500 NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_profile" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"status" "voice_status" DEFAULT 'learning' NOT NULL,
	"source" "voice_source" DEFAULT 'learned' NOT NULL,
	"summary" text,
	"greeting_style" text,
	"signoff_style" text,
	"avg_length_words" integer,
	"formality" text,
	"phrases_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phrases_avoided" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"learned_from_count" integer DEFAULT 0 NOT NULL,
	"learned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_profile" ADD CONSTRAINT "business_profile_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profile" ADD CONSTRAINT "voice_profile_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;