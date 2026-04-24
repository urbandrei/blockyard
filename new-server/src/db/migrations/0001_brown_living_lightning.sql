CREATE TABLE IF NOT EXISTS "short_links" (
	"id" text PRIMARY KEY NOT NULL,
	"share_code" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "short_links_share_code_unique" UNIQUE("share_code")
);
