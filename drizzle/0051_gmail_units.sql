CREATE TABLE "gmail_units" (
	"mailbox_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"units" integer NOT NULL,
	CONSTRAINT "gmail_units_mailbox_id_minute_pk" PRIMARY KEY("mailbox_id","minute")
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "gmail_cool_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_units" ADD CONSTRAINT "gmail_units_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;