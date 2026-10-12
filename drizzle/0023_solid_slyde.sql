CREATE TABLE "price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"service" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"quoted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "review_url" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "quote_outcome_source" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "invoice_paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "invoice_paid_source" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "complained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_history_thread_uq" ON "price_history" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "price_history_ws_quoted_idx" ON "price_history" USING btree ("workspace_id","quoted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_one_closing_question_per_thread" ON "drafts" USING btree ("thread_id") WHERE purpose = 'closing_question';--> statement-breakpoint
-- Hand-added (plan M7, amendment A13): every Won/Lost set before this column existed was the owner's.
UPDATE "threads" SET "quote_outcome_source" = 'owner' WHERE "quote_outcome" IS NOT NULL AND "quote_outcome_source" IS NULL;