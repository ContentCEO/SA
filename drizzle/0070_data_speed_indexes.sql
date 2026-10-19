-- Data and speed, step 1 (Check 30 P1 + Check 29 P6 + Check 30 P4): seven indexes, nothing else.
-- (Check 30 P4's messages_mailbox_reply_address_idx is held back: see src/db/schema.ts, messages.)
-- Additive only: old code keeps working; nothing is dropped or changed.
-- Plain CREATE INDEX, not CONCURRENTLY: drizzle's migrator runs every pending migration inside
-- one transaction, and CREATE INDEX CONCURRENTLY can't run in a transaction. A plain build holds
-- a SHARE lock (reads go on, writes to that table wait) for as long as the build takes. At
-- today's sizes (a handful of shops; drafts/threads in the thousands, messages in the tens of
-- thousands) each build takes well under a second. Before merging, check the sizes on the
-- shared database:
--   select relname, n_live_tup from pg_stat_user_tables
--   where relname in ('drafts', 'messages', 'threads', 'activity_log');
-- If messages is ever in the millions, build these by hand with CONCURRENTLY first (same names,
-- the statements below say IF NOT EXISTS) instead.
CREATE INDEX IF NOT EXISTS "activity_digest_sent_idx" ON "activity_log" USING btree ("workspace_id","created_at") WHERE action = 'digest_sent';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_notes_mailbox_idx" ON "customer_notes" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drafts_thread_created_idx" ON "drafts" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drafts_reply_to_message_idx" ON "drafts" USING btree ("reply_to_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_mailbox_from_sent_idx" ON "messages" USING btree ("mailbox_id","from_address","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_workspace_idx" ON "push_subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_mailbox_classified_idx" ON "threads" USING btree ("mailbox_id","classified_at");