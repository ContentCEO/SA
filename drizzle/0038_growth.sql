CREATE TABLE "growth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_on" date NOT NULL,
	"services" text[] DEFAULT '{}' NOT NULL,
	"time_zone" text DEFAULT 'America/New_York' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "growth_clients_status" CHECK ("growth_clients"."status" in ('active', 'paused', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "growth_monthly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"growth_client_id" uuid NOT NULL,
	"month" text NOT NULL,
	"new_leads" integer,
	"calls" integer,
	"jobs_won" integer,
	"money_won_cents" integer,
	"reviews_gained" integer,
	"ad_spend_cents" integer,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_monthly_month" CHECK ("growth_monthly"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "growth_monthly_not_negative" CHECK (coalesce("growth_monthly"."new_leads", 0) >= 0 and coalesce("growth_monthly"."calls", 0) >= 0 and coalesce("growth_monthly"."jobs_won", 0) >= 0 and coalesce("growth_monthly"."money_won_cents", 0) >= 0 and coalesce("growth_monthly"."reviews_gained", 0) >= 0 and coalesce("growth_monthly"."ad_spend_cents", 0) >= 0),
	CONSTRAINT "growth_monthly_note_len" CHECK ("growth_monthly"."note" is null or char_length("growth_monthly"."note") <= 280)
);
--> statement-breakpoint
CREATE TABLE "growth_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"growth_client_id" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "growth_updates_title_len" CHECK (char_length("growth_updates"."title") between 1 and 80),
	CONSTRAINT "growth_updates_body_len" CHECK (char_length("growth_updates"."body") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "growth_invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "growth_services" text[];--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "growth_started_on" date;--> statement-breakpoint
ALTER TABLE "growth_clients" ADD CONSTRAINT "growth_clients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_monthly" ADD CONSTRAINT "growth_monthly_growth_client_id_growth_clients_id_fk" FOREIGN KEY ("growth_client_id") REFERENCES "public"."growth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_updates" ADD CONSTRAINT "growth_updates_growth_client_id_growth_clients_id_fk" FOREIGN KEY ("growth_client_id") REFERENCES "public"."growth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "growth_clients_workspace_uq" ON "growth_clients" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_monthly_client_month_uq" ON "growth_monthly" USING btree ("growth_client_id","month");--> statement-breakpoint
CREATE INDEX "growth_updates_client_idx" ON "growth_updates" USING btree ("growth_client_id","posted_at");