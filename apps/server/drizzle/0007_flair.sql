CREATE TABLE "flair_introductions" (
	"flair_id" text PRIMARY KEY NOT NULL,
	"introduced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_flair" (
	"user_id" bigint NOT NULL,
	"flair_id" text NOT NULL,
	"game_id" bigint NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_flair_user_id_flair_id_pk" PRIMARY KEY("user_id","flair_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "flair_worn" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "user_flair" ADD CONSTRAINT "user_flair_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_flair" ADD CONSTRAINT "user_flair_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;