CREATE TABLE "admin_actions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"group_id" bigint NOT NULL,
	"admin_user_id" bigint NOT NULL,
	"action" text NOT NULL,
	"target_game_id" bigint,
	"target_user_id" bigint,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_images" (
	"key" text PRIMARY KEY NOT NULL,
	"telegram_file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "challenges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"group_id" bigint NOT NULL,
	"challenger_id" bigint NOT NULL,
	"opponent_id" bigint,
	"time_per_move" integer,
	"challenger_colour" text NOT NULL,
	"rated" boolean NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" bigint,
	"thread_id" bigint,
	"game_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "challenges_publicId_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "games_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"group_id" bigint NOT NULL,
	"white_id" bigint NOT NULL,
	"black_id" bigint NOT NULL,
	"time_per_move" integer,
	"rated" boolean NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"result" text,
	"end_reason" text,
	"fen" text NOT NULL,
	"ply_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone,
	"reminder_at" timestamp with time zone,
	"draw_offer_by" text,
	"draw_offer_ply" integer,
	"last_draw_offer_ply_white" integer,
	"last_draw_offer_ply_black" integer,
	"card_message_id" bigint,
	"card_thread_id" bigint,
	"card_missing" boolean DEFAULT false NOT NULL,
	"lichess_url" text,
	"lichess_import_status" text,
	"white_rating_before" double precision,
	"white_rating_after" double precision,
	"white_rd_before" double precision,
	"white_rd_after" double precision,
	"black_rating_before" double precision,
	"black_rating_after" double precision,
	"black_rd_before" double precision,
	"black_rd_after" double precision,
	"voided_at" timestamp with time zone,
	"voided_by" bigint,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"last_move_at" timestamp with time zone,
	CONSTRAINT "games_publicId_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"status" text DEFAULT 'member' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"blocked_by" bigint,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"is_forum" boolean DEFAULT false NOT NULL,
	"bot_status" text DEFAULT 'member' NOT NULL,
	"bot_is_admin" boolean DEFAULT false NOT NULL,
	"bot_can_pin" boolean DEFAULT false NOT NULL,
	"welcome_message_id" bigint,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "groups_telegramChatId_unique" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"dedup_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "moves" (
	"game_id" bigint NOT NULL,
	"ply" integer NOT NULL,
	"uci" text NOT NULL,
	"san" text NOT NULL,
	"fen_after" text NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_move_id" text,
	CONSTRAINT "moves_game_id_ply_pk" PRIMARY KEY("game_id","ply"),
	CONSTRAINT "moves_client_move_unique" UNIQUE("game_id","client_move_id")
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"group_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"rating" double precision NOT NULL,
	"rd" double precision NOT NULL,
	"volatility" double precision NOT NULL,
	"games_played" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"last_rated_game_at" timestamp with time zone,
	CONSTRAINT "ratings_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shares_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"game_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"ply" integer NOT NULL,
	"message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"telegram_user_id" bigint,
	"first_name" text NOT NULL,
	"username" text,
	"language_code" text,
	"dm_allowed" boolean DEFAULT false NOT NULL,
	"write_access_asked_at" timestamp with time zone,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_telegramUserId_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_challenger_id_users_id_fk" FOREIGN KEY ("challenger_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_opponent_id_users_id_fk" FOREIGN KEY ("opponent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_white_id_users_id_fk" FOREIGN KEY ("white_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_black_id_users_id_fk" FOREIGN KEY ("black_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "challenges_status_expires" ON "challenges" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "challenges_group_status" ON "challenges" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "games_deadline_active" ON "games" USING btree ("deadline_at") WHERE "games"."status" = 'active';--> statement-breakpoint
CREATE INDEX "games_reminder_active" ON "games" USING btree ("reminder_at") WHERE "games"."status" = 'active' and "games"."reminder_at" is not null;--> statement-breakpoint
CREATE INDEX "games_group_status_last_move" ON "games" USING btree ("group_id","status","last_move_at");--> statement-breakpoint
CREATE INDEX "games_white" ON "games" USING btree ("white_id");--> statement-breakpoint
CREATE INDEX "games_black" ON "games" USING btree ("black_id");--> statement-breakpoint
CREATE INDEX "group_members_seen" ON "group_members" USING btree ("group_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedup_pending" ON "jobs" USING btree ("dedup_key") WHERE "jobs"."done_at" is null;--> statement-breakpoint
CREATE INDEX "jobs_run_at_pending" ON "jobs" USING btree ("run_at") WHERE "jobs"."done_at" is null;--> statement-breakpoint
CREATE INDEX "shares_user_created" ON "shares" USING btree ("user_id","created_at");