ALTER TABLE "mailboxes" ADD COLUMN "plan_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "trial_emails_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "trial_emails_sent" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_one_thank_you_per_thread" ON "drafts" USING btree ("thread_id") WHERE purpose in ('thank_you', 'thank_you_review') and status <> 'expired';