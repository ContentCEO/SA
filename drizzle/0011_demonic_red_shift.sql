ALTER TABLE "mailboxes" ADD COLUMN "access_lost_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "access_alerts_sent" integer DEFAULT 0 NOT NULL;