CREATE TABLE "plan_participant_introduction" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"plan_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"introduced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "plan_participant_introduction_plan_user_uq" UNIQUE("plan_id","user_id"),
	CONSTRAINT "plan_participant_introduction_id_ulid_chk" CHECK ("plan_participant_introduction"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
);
--> statement-breakpoint
ALTER TABLE "plan_participant_introduction" ADD CONSTRAINT "plan_participant_introduction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;