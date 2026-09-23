ALTER TABLE "games" ADD COLUMN "engine_level" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_engine" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_engine" ON "users" USING btree ("is_engine") WHERE "users"."is_engine";--> statement-breakpoint
INSERT INTO "users" ("first_name", "is_engine", "dm_allowed")
VALUES ('Stockfish', true, false)
ON CONFLICT DO NOTHING;