DO $$ BEGIN
 CREATE TYPE "public"."play_kind" AS ENUM('campaign', 'community');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "levels" ADD COLUMN IF NOT EXISTS "completions" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "play_kind" NOT NULL,
	"level_id" text NOT NULL,
	"anon_token" text NOT NULL,
	"opened_at" bigint NOT NULL,
	"completed_at" bigint,
	"hint_count" integer DEFAULT 0 NOT NULL,
	"time_spent_ms" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plays" ADD CONSTRAINT "plays_anon_token_tokens_token_fk" FOREIGN KEY ("anon_token") REFERENCES "public"."tokens"("token") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plays_kind_level_id" ON "plays" USING btree ("kind","level_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plays_kind_completed_at" ON "plays" USING btree ("kind","completed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plays_anon_token" ON "plays" USING btree ("anon_token");
