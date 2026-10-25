CREATE TABLE "sms_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_sid" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "sms_stopped_reason" text;--> statement-breakpoint
ALTER TABLE "sms_deliveries" ADD CONSTRAINT "sms_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_deliveries_message_sid_uq" ON "sms_deliveries" USING btree ("message_sid");--> statement-breakpoint
CREATE INDEX "sms_deliveries_workspace_created_idx" ON "sms_deliveries" USING btree ("workspace_id","created_at");