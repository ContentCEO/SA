CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"address" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notes_body_len" CHECK (char_length("customer_notes"."body") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "owner_sender_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"scope" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_sender_rules_action" CHECK ("owner_sender_rules"."action" in ('junk', 'no_draft', 'needs_me')),
	CONSTRAINT "owner_sender_rules_scope" CHECK ("owner_sender_rules"."scope" in ('address', 'domain')),
	CONSTRAINT "owner_sender_rules_needs_me_domain" CHECK ("owner_sender_rules"."action" <> 'needs_me' or "owner_sender_rules"."scope" = 'domain')
);
--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "away_back_on" text;--> statement-breakpoint
ALTER TABLE "seasonal_notes" ADD COLUMN "away" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "category_manual" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "category_manual_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_sender_rules" ADD CONSTRAINT "owner_sender_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_notes_workspace_address_uq" ON "customer_notes" USING btree ("workspace_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_sender_rules_workspace_pattern_uq" ON "owner_sender_rules" USING btree ("workspace_id","pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "seasonal_notes_one_away" ON "seasonal_notes" USING btree ("workspace_id") WHERE away;