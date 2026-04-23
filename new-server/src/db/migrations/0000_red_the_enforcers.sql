CREATE TYPE "public"."level_status" AS ENUM('pending', 'public', 'rejected');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "level_status" DEFAULT 'pending' NOT NULL,
	"author" text NOT NULL,
	"name" text NOT NULL,
	"hint" text,
	"cols" integer NOT NULL,
	"rows" integer NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"rating_sum" integer DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"submitted_by_token" text NOT NULL,
	"submitted_from_ip" text,
	"rejected_reason" text,
	"rejected_by" text,
	"approved_by" text,
	"discord_message_id" text,
	"share_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "likes" (
	"token" text NOT NULL,
	"level_id" uuid NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "likes_token_level_id_pk" PRIMARY KEY("token","level_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ratings" (
	"token" text NOT NULL,
	"level_id" uuid NOT NULL,
	"stars" smallint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "ratings_token_level_id_pk" PRIMARY KEY("token","level_id"),
	CONSTRAINT "stars_1_to_5" CHECK ("ratings"."stars" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"ip" text,
	"ua" text,
	"banned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "likes" ADD CONSTRAINT "likes_level_id_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."levels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ratings" ADD CONSTRAINT "ratings_level_id_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."levels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "levels_status_created_at" ON "levels" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "levels_status_likes" ON "levels" USING btree ("status","likes","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "likes_by_level" ON "likes" USING btree ("level_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ratings_by_level" ON "ratings" USING btree ("level_id");