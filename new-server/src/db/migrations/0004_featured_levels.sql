CREATE TABLE IF NOT EXISTS "featured_levels" (
	"utc_date" date PRIMARY KEY NOT NULL,
	"level_id" uuid NOT NULL,
	"added_by" text NOT NULL,
	"promoted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "featured_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"level_id" uuid NOT NULL,
	"added_by" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "featured_queue_level_id_unique" UNIQUE("level_id")
);
