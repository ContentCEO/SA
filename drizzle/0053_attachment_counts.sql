ALTER TABLE "messages" ADD COLUMN "attachment_images" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_pdfs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_other" integer DEFAULT 0 NOT NULL;