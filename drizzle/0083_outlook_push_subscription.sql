ALTER TABLE "mailboxes" ADD COLUMN "push_subscription_id" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "push_client_state_sha256" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_push_subscription_uq" ON "mailboxes" USING btree ("push_subscription_id");