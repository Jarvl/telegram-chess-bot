CREATE TABLE "tips" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tips_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint,
	"telegram_user_id" bigint NOT NULL,
	"stars" integer NOT NULL,
	"telegram_payment_charge_id" text NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "tips_telegramPaymentChargeId_unique" UNIQUE("telegram_payment_charge_id")
);
--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;