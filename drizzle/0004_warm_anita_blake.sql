CREATE TYPE "public"."draft_kind" AS ENUM('reply', 'followup');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('pending', 'sent', 'edited_and_sent', 'discarded', 'expired');--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"reply_to_message_id" uuid,
	"kind" "draft_kind" DEFAULT 'reply' NOT NULL,
	"gmail_draft_id" text,
	"gmail_message_id" text,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"original_body" text,
	"status" "draft_status" DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence_pct" integer DEFAULT 0 NOT NULL,
	"prompt_version" text,
	"closed_note" text,
	"sent_gmail_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drafts_mailbox_status_idx" ON "drafts" USING btree ("mailbox_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_one_pending_per_thread" ON "drafts" USING btree ("thread_id") WHERE status = 'pending';