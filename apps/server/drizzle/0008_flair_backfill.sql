CREATE TABLE "flair_backfills" (
	"flair_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "flair_introductions" CASCADE;