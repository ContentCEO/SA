CREATE TABLE "edit_signals" (
	"draft_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"words_before" integer NOT NULL,
	"words_after" integer NOT NULL,
	"opening_changed" boolean NOT NULL,
	"signoff_changed" boolean NOT NULL,
	"first_sentence_cut" boolean NOT NULL,
	"sentences_removed" integer NOT NULL,
	"sentences_added" integer NOT NULL,
	"tone_shift" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"target_words" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "edit_signals" ADD CONSTRAINT "edit_signals_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_signals" ADD CONSTRAINT "edit_signals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_suggestions" ADD CONSTRAINT "voice_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edit_signals_workspace_idx" ON "edit_signals" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_suggestions_workspace_idx" ON "voice_suggestions" USING btree ("workspace_id","status");