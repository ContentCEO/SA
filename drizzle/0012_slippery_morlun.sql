ALTER TABLE "threads" ADD COLUMN "quote_outcome" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "quote_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "quote_amount_cents" integer;