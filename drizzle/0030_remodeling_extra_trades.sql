ALTER TYPE "public"."trade" ADD VALUE 'remodeling' BEFORE 'other';--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "extra_trades" text[] DEFAULT '{}' NOT NULL;