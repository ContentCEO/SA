CREATE TABLE "waitlist" (
	"email" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"trade" "trade",
	"team_size" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_at" timestamp with time zone
);
