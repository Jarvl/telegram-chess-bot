CREATE TABLE "user_photos" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"file_unique_id" text,
	"hash" text,
	"bytes" "bytea",
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "photo_hash" text;--> statement-breakpoint
ALTER TABLE "user_photos" ADD CONSTRAINT "user_photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_photos_hash" ON "user_photos" USING btree ("hash");