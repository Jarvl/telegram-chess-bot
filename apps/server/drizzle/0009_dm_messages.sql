CREATE TABLE "dm_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dm_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"game_id" bigint,
	"challenge_id" bigint,
	"telegram_message_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"stub" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dm_messages_one_subject" CHECK (("dm_messages"."game_id" is null) <> ("dm_messages"."challenge_id" is null))
);
--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dm_messages_user_game" ON "dm_messages" USING btree ("user_id","game_id") WHERE "dm_messages"."game_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "dm_messages_user_challenge" ON "dm_messages" USING btree ("user_id","challenge_id") WHERE "dm_messages"."challenge_id" is not null;