CREATE TYPE "public"."direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"rfc822_message_id" text,
	"references" text,
	"from_address" text,
	"from_name" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"direction" "direction" NOT NULL,
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snippet" text,
	"body_text" text,
	"body_purged_at" timestamp with time zone,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"subject" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_message_at" timestamp with time zone,
	"in_inbox" boolean DEFAULT false NOT NULL,
	"category" text,
	"priority" text,
	"needs_owner" boolean DEFAULT false NOT NULL,
	"needs_owner_reason" text,
	"awaiting_reply_since" timestamp with time zone,
	"followup_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "backfill_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_mailbox_gmail_uq" ON "messages" USING btree ("mailbox_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "messages_thread_sent_idx" ON "messages" USING btree ("thread_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_retention_idx" ON "messages" USING btree ("sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_mailbox_gmail_uq" ON "threads" USING btree ("mailbox_id","gmail_thread_id");--> statement-breakpoint
CREATE INDEX "threads_mailbox_last_idx" ON "threads" USING btree ("mailbox_id","last_message_at");