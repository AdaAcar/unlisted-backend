CREATE TYPE "public"."application_member_confirmation_state" AS ENUM('unconfirmed', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."application_member_invitation_state" AS ENUM('not_invited', 'invited', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."application_state" AS ENUM('draft', 'awaiting_confirmation', 'submitted', 'shortlisted', 'invited', 'accepted', 'declined', 'expired', 'rejected', 'withdrawn', 'approved');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_role" AS ENUM('user', 'circle_lead', 'moderator', 'system');--> statement-breakpoint
CREATE TYPE "public"."circle_member_role" AS ENUM('lead', 'member');--> statement-breakpoint
CREATE TYPE "public"."circle_member_status" AS ENUM('invited', 'active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."mode" AS ENUM('planned', 'tonight');--> statement-breakpoint
CREATE TYPE "public"."plan_cancellation_kind" AS ENUM('host', 'non_viable');--> statement-breakpoint
CREATE TYPE "public"."plan_state" AS ENUM('draft', 'published', 'applications_closed', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."signal_kind" AS ENUM('report', 'non_return', 'early_departure', 'low_response', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."user_standing" AS ENUM('good', 'restricted', 'suspended', 'banned');--> statement-breakpoint
CREATE TYPE "public"."venue_type" AS ENUM('bar', 'restaurant', 'club', 'beach', 'cafe');--> statement-breakpoint
CREATE TYPE "public"."verification_state" AS ENUM('none', 'pending', 'verified', 'failed');--> statement-breakpoint
CREATE TABLE "user" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"first_name" varchar(80) NOT NULL,
	"photos" text[] DEFAULT '{}'::text[] NOT NULL,
	"bio" text,
	"age" integer,
	"district" varchar(80),
	"verification_state" "verification_state" DEFAULT 'none' NOT NULL,
	"verification_ref" text,
	"identity_hash" text,
	"standing" "user_standing" DEFAULT 'good' NOT NULL,
	"signal_score" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_id_ulid_chk" CHECK ("user"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "user_age_adult_chk" CHECK ("user"."age" IS NULL OR "user"."age" >= 18),
	CONSTRAINT "user_photos_max_chk" CHECK (cardinality("user"."photos") <= 2)
);
--> statement-breakpoint
CREATE TABLE "record" (
	"user_id" varchar(26) PRIMARY KEY NOT NULL,
	"plans_attended" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"late_declines" integer DEFAULT 0 NOT NULL,
	"repeat_invitations" integer DEFAULT 0 NOT NULL,
	"circles_led" integer DEFAULT 0 NOT NULL,
	"first_plan_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_counts_nonneg_chk" CHECK ("record"."plans_attended" >= 0 AND "record"."no_shows" >= 0 AND "record"."late_declines" >= 0
          AND "record"."repeat_invitations" >= 0 AND "record"."circles_led" >= 0)
);
--> statement-breakpoint
CREATE TABLE "circle" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"lead_user_id" varchar(26) NOT NULL,
	"plans_hosted" integer DEFAULT 0 NOT NULL,
	"plans_attended" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"late_declines" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circle_id_ulid_chk" CHECK ("circle"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "circle_record_nonneg_chk" CHECK ("circle"."plans_hosted" >= 0 AND "circle"."plans_attended" >= 0 AND "circle"."no_shows" >= 0
          AND "circle"."late_declines" >= 0)
);
--> statement-breakpoint
CREATE TABLE "circle_member" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"circle_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"role" "circle_member_role" DEFAULT 'member' NOT NULL,
	"status" "circle_member_status" DEFAULT 'invited' NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circle_member_id_ulid_chk" CHECK ("circle_member"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
);
--> statement-breakpoint
CREATE TABLE "venue" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"address" text NOT NULL,
	"district" varchar(80) NOT NULL,
	"type" "venue_type" NOT NULL,
	"operator_verified" boolean DEFAULT false NOT NULL,
	"licence_ref" text,
	"capacity_hint" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venue_id_ulid_chk" CHECK ("venue"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "venue_capacity_hint_nonneg_chk" CHECK ("venue"."capacity_hint" IS NULL OR "venue"."capacity_hint" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plan" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"host_circle_id" varchar(26) NOT NULL,
	"venue_id" varchar(26) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"open_spots" integer NOT NULL,
	"min_group_size" integer NOT NULL,
	"note" text,
	"district" varchar(80) NOT NULL,
	"venue_type" "venue_type" NOT NULL,
	"state" "plan_state" DEFAULT 'draft' NOT NULL,
	"mode" "mode",
	"published_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_kind" "plan_cancellation_kind",
	"applications_closed_at" timestamp with time zone,
	"viable_at" timestamp with time zone,
	"confirmed_host_count" integer DEFAULT 0 NOT NULL,
	"accepted_guest_count" integer DEFAULT 0 NOT NULL,
	"held_count" integer DEFAULT 0 NOT NULL,
	"confirmed_total" integer GENERATED ALWAYS AS (confirmed_host_count + accepted_guest_count) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_id_ulid_chk" CHECK ("plan"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "plan_open_spots_nonneg_chk" CHECK ("plan"."open_spots" >= 0),
	CONSTRAINT "plan_min_group_size_chk" CHECK ("plan"."min_group_size" >= 1),
	CONSTRAINT "plan_ends_after_starts_chk" CHECK ("plan"."ends_at" IS NULL OR "plan"."ends_at" > "plan"."starts_at"),
	CONSTRAINT "plan_mode_set_after_draft_chk" CHECK ("plan"."state" = 'draft' OR "plan"."mode" IS NOT NULL),
	CONSTRAINT "plan_confirmed_host_nonneg_chk" CHECK ("plan"."confirmed_host_count" >= 0),
	CONSTRAINT "plan_accepted_guest_nonneg_chk" CHECK ("plan"."accepted_guest_count" >= 0),
	CONSTRAINT "plan_held_nonneg_chk" CHECK ("plan"."held_count" >= 0),
	CONSTRAINT "plan_capacity_ceiling_chk" CHECK ("plan"."accepted_guest_count" + "plan"."held_count" <= "plan"."open_spots"),
	CONSTRAINT "plan_cancellation_kind_chk" CHECK ("plan"."state" = 'cancelled' OR "plan"."cancellation_kind" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "application" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"plan_id" varchar(26) NOT NULL,
	"applicant_circle_id" varchar(26),
	"solo_user_id" varchar(26),
	"mode" "mode" NOT NULL,
	"state" "application_state" NOT NULL,
	"note" text,
	"response_deadline" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_id_ulid_chk" CHECK ("application"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "application_circle_xor_solo_chk" CHECK (("application"."applicant_circle_id" IS NULL) <> ("application"."solo_user_id" IS NULL)),
	CONSTRAINT "application_response_deadline_mode_chk" CHECK ("application"."mode" = 'planned' OR "application"."response_deadline" IS NULL),
	CONSTRAINT "application_state_by_mode_chk" CHECK (("application"."mode" = 'planned' AND "application"."state" IN (
            'draft', 'awaiting_confirmation', 'submitted', 'shortlisted', 'invited',
            'accepted', 'declined', 'expired', 'rejected', 'withdrawn'
          ))
          OR ("application"."mode" = 'tonight' AND "application"."state" IN (
            'submitted', 'approved', 'rejected', 'withdrawn', 'expired'
          )))
);
--> statement-breakpoint
CREATE TABLE "application_member" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"application_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"confirmation_state" "application_member_confirmation_state" DEFAULT 'unconfirmed' NOT NULL,
	"confirmed_version_hash" text,
	"invitation_state" "application_member_invitation_state" DEFAULT 'not_invited' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_member_id_ulid_chk" CHECK ("application_member"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "application_member_confirmed_hash_chk" CHECK (("application_member"."confirmation_state" = 'confirmed') = ("application_member"."confirmed_version_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "message_thread" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"plan_id" varchar(26) NOT NULL,
	"circle_a_id" varchar(26) NOT NULL,
	"circle_b_id" varchar(26) NOT NULL,
	"participant_count" integer NOT NULL,
	"retention_delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "message_thread_id_ulid_chk" CHECK ("message_thread"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "message_thread_plan_id_ulid_chk" CHECK ("message_thread"."plan_id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "message_thread_distinct_circles_chk" CHECK ("message_thread"."circle_a_id" <> "message_thread"."circle_b_id")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"thread_id" varchar(26) NOT NULL,
	"sender_user_id" varchar(26) NOT NULL,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "message_id_ulid_chk" CHECK ("message"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
);
--> statement-breakpoint
CREATE TABLE "signal" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"subject_user_id" varchar(26) NOT NULL,
	"reporter_user_id" varchar(26),
	"plan_id" varchar(26),
	"kind" "signal_kind" NOT NULL,
	"weight" integer NOT NULL,
	"case_id" varchar(26),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "signal_id_ulid_chk" CHECK ("signal"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "signal_case_id_ulid_chk" CHECK ("signal"."case_id" IS NULL OR "signal"."case_id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
);
--> statement-breakpoint
CREATE TABLE "block" (
	"blocker_user_id" varchar(26) NOT NULL,
	"blocked_user_id" varchar(26) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "block_blocker_user_id_blocked_user_id_pk" PRIMARY KEY("blocker_user_id","blocked_user_id"),
	CONSTRAINT "block_no_self_chk" CHECK ("block"."blocker_user_id" <> "block"."blocked_user_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"actor_id" varchar(26),
	"actor_role" "audit_actor_role" NOT NULL,
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(60) NOT NULL,
	"resource_id" varchar(26) NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"reason" text,
	"ip_hash" varchar(64),
	"user_agent_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_id_ulid_chk" CHECK ("audit_log"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "audit_log_resource_id_ulid_chk" CHECK ("audit_log"."resource_id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "audit_log_moderator_reason_chk" CHECK ("audit_log"."actor_role" <> 'moderator' OR "audit_log"."reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle" ADD CONSTRAINT "circle_lead_user_id_user_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle_member" ADD CONSTRAINT "circle_member_circle_id_circle_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle_member" ADD CONSTRAINT "circle_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_host_circle_id_circle_id_fk" FOREIGN KEY ("host_circle_id") REFERENCES "public"."circle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_venue_id_venue_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venue"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_applicant_circle_id_circle_id_fk" FOREIGN KEY ("applicant_circle_id") REFERENCES "public"."circle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_solo_user_id_user_id_fk" FOREIGN KEY ("solo_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_member" ADD CONSTRAINT "application_member_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_member" ADD CONSTRAINT "application_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_circle_a_id_circle_id_fk" FOREIGN KEY ("circle_a_id") REFERENCES "public"."circle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_circle_b_id_circle_id_fk" FOREIGN KEY ("circle_b_id") REFERENCES "public"."circle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_id_message_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_sender_user_id_user_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_blocker_user_id_user_id_fk" FOREIGN KEY ("blocker_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_blocked_user_id_user_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identity_hash_uq" ON "user" USING btree ("identity_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "circle_member_active_uq" ON "circle_member" USING btree ("circle_id","user_id") WHERE "circle_member"."status" <> 'removed';--> statement-breakpoint
CREATE INDEX "circle_member_user_idx" ON "circle_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "circle_member_circle_idx" ON "circle_member" USING btree ("circle_id");--> statement-breakpoint
CREATE INDEX "venue_district_type_idx" ON "venue" USING btree ("district","type");--> statement-breakpoint
CREATE INDEX "plan_discovery_idx" ON "plan" USING btree ("district","state","starts_at");--> statement-breakpoint
CREATE INDEX "plan_host_circle_idx" ON "plan" USING btree ("host_circle_id");--> statement-breakpoint
CREATE INDEX "plan_venue_idx" ON "plan" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "application_plan_idx" ON "application" USING btree ("plan_id","state");--> statement-breakpoint
CREATE INDEX "application_applicant_circle_idx" ON "application" USING btree ("applicant_circle_id");--> statement-breakpoint
CREATE INDEX "application_solo_user_idx" ON "application" USING btree ("solo_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "application_member_app_user_uq" ON "application_member" USING btree ("application_id","user_id");--> statement-breakpoint
CREATE INDEX "application_member_user_idx" ON "application_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_thread_plan_idx" ON "message_thread" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "message_thread_circle_a_idx" ON "message_thread" USING btree ("circle_a_id");--> statement-breakpoint
CREATE INDEX "message_thread_circle_b_idx" ON "message_thread" USING btree ("circle_b_id");--> statement-breakpoint
CREATE INDEX "message_thread_created_idx" ON "message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "signal_subject_idx" ON "signal" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "signal_case_idx" ON "signal" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "block_blocked_idx" ON "block" USING btree ("blocked_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at");