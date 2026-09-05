CREATE TABLE "session" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_id_ulid_chk" CHECK ("session"."id" ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "session_token_hash_chk" CHECK ("session"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_hash_uq" ON "session" USING btree ("token_hash");
--> statement-breakpoint

-- B1: narrow, explicitly justified privileges, mirroring 0006_audit_append.sql
-- rather than the broad CRUD grant 0002 used for the original 13 tables.
-- 0004_a3_corrections.sql's `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON
-- TABLES FROM unlisted_app, unlisted_admin` already applies to this new
-- table, so unlisted_app/unlisted_admin start with zero privileges here —
-- everything below is additive, not a correction of something broader.
--
-- Explicit ownership, matching every prior table (0002 for the original 13,
-- 0004 for plan_participant_introduction): the integration test harness runs
-- migrations as a superuser rather than through unlisted_migrator, so
-- without this line the table would end up owned by whoever ran CREATE
-- TABLE instead of the one deliberate owner every other table has.
ALTER TABLE public.session OWNER TO unlisted_migrator;
--> statement-breakpoint

ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.session FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Session mutations happen inside withActor once an actor is already
-- resolved (login: right after authenticate() + loadActorByUserId(); logout
-- and rotation: an already-authenticated request). All three are self-scoped
-- — a transaction can only ever touch its own session rows. There is no
-- UPDATE policy and no UPDATE grant below: rotation is delete-then-insert,
-- never an in-place mutation.
--
-- SELECT is included even though no route reads session rows back for
-- display: Postgres requires SELECT on any column a DELETE's WHERE clause
-- filters on (`deleteSessionByTokenHash` filters on user_id and
-- token_hash), not only the DELETE privilege itself. Without it, the DELETE
-- fails closed with "permission denied" rather than silently matching zero
-- rows — self-scoped by the same predicate as insert/delete, so this does
-- not let the app role read any other user's session.
CREATE POLICY session_app_insert ON public.session FOR INSERT TO unlisted_app
  WITH CHECK (app_actor_present() AND user_id = app_current_actor_id());
--> statement-breakpoint
CREATE POLICY session_app_read ON public.session FOR SELECT TO unlisted_app
  USING (app_actor_present() AND user_id = app_current_actor_id());
--> statement-breakpoint
CREATE POLICY session_app_delete ON public.session FOR DELETE TO unlisted_app
  USING (app_actor_present() AND user_id = app_current_actor_id());
--> statement-breakpoint

-- Verifying an incoming request's bearer token happens before any actor is
-- known — there is nothing yet to scope the read to. This is the same
-- pre-authentication shape `loadActorByUserId` already has through
-- unlisted_admin (db/scope/resolve.ts), extending its unscoped six-table
-- read surface (user, block, circle_member, plan, application,
-- application_member) to seven. unlisted_admin gets nothing else here: no
-- INSERT, UPDATE, or DELETE.
CREATE POLICY session_admin_read ON public.session FOR SELECT TO unlisted_admin
  USING (true);
--> statement-breakpoint

GRANT SELECT, INSERT, DELETE ON public.session TO unlisted_app;
--> statement-breakpoint
GRANT SELECT ON public.session TO unlisted_admin;