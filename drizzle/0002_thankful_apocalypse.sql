CREATE TABLE "usage" (
	"workspace_id" uuid NOT NULL,
	"period" text NOT NULL,
	"ai_calls" integer DEFAULT 0 NOT NULL,
	"model_tokens_in" integer DEFAULT 0 NOT NULL,
	"model_tokens_out" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"drafts_created" integer DEFAULT 0 NOT NULL,
	"emails_sent" integer DEFAULT 0 NOT NULL,
	"estimated_cost_centicents" integer DEFAULT 0 NOT NULL,
	"cap_alerted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "needs_owner_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "extracted" jsonb;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_workspace_period_uq" ON "usage" USING btree ("workspace_id","period");