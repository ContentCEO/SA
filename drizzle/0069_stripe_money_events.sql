CREATE TABLE "stripe_money_events" (
	"id" text NOT NULL,
	"workspace_id" uuid,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"includes_setup" boolean DEFAULT false NOT NULL,
	"evidence_due_by" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_money_events_id_kind_pk" PRIMARY KEY("id","kind")
);
--> statement-breakpoint
ALTER TABLE "stripe_money_events" ADD CONSTRAINT "stripe_money_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_money_events_workspace_idx" ON "stripe_money_events" USING btree ("workspace_id");