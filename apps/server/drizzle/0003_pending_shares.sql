CREATE TABLE "pending_shares" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"game_id" bigint NOT NULL,
	"ply" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_shares" ADD CONSTRAINT "pending_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_shares" ADD CONSTRAINT "pending_shares_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;