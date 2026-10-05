CREATE TYPE "public"."rule_mode" AS ENUM('draft', 'autopilot');--> statement-breakpoint
CREATE TABLE "rules" (
	"workspace_id" uuid NOT NULL,
	"category" text NOT NULL,
	"mode" "rule_mode" DEFAULT 'draft' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "auto_send_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rules_workspace_category_uq" ON "rules" USING btree ("workspace_id","category");