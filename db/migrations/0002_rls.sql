-- A3: role separation and row-level-security backstop.
-- Application visibility predicates live in db/scope/visibility.ts. The SQL
-- helpers below deliberately mirror its bidirectional block and standing rules.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unlisted_migrator') THEN
    CREATE ROLE unlisted_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unlisted_app') THEN
    CREATE ROLE unlisted_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unlisted_admin') THEN
    CREATE ROLE unlisted_admin LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
ALTER ROLE unlisted_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'unlisted_migrator';
--> statement-breakpoint
ALTER ROLE unlisted_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD 'unlisted_app';
--> statement-breakpoint
ALTER ROLE unlisted_admin WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT PASSWORD 'unlisted_admin';
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO unlisted_app, unlisted_admin, unlisted_migrator;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO unlisted_migrator;
--> statement-breakpoint

-- SECURITY DEFINER visibility helpers are owned by the BYPASSRLS admin role so
-- their internal block/user reads cannot be filtered recursively.
CREATE FUNCTION app_current_actor_id() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE FUNCTION app_actor_present() RETURNS boolean AS $$
  SELECT public.app_current_actor_id() IS NOT NULL
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE FUNCTION app_user_visible(counterparty_user_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_actor_present()
    AND NOT EXISTS (
      SELECT 1 FROM public.block b
      WHERE (b.blocker_user_id = public.app_current_actor_id()
             AND b.blocked_user_id = counterparty_user_id)
         OR (b.blocker_user_id = counterparty_user_id
             AND b.blocked_user_id = public.app_current_actor_id())
    )
    AND EXISTS (
      SELECT 1 FROM public."user" u
      WHERE u.id = counterparty_user_id
        AND (u.standing NOT IN ('restricted', 'suspended', 'banned')
             OR u.id = public.app_current_actor_id())
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE FUNCTION app_circle_visible(counterparty_circle_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_actor_present()
    AND EXISTS (
      SELECT 1 FROM public.circle_member cm
      WHERE cm.circle_id = counterparty_circle_id AND cm.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.circle_member cm
      WHERE cm.circle_id = counterparty_circle_id
        AND cm.status = 'active'
        AND NOT public.app_user_visible(cm.user_id)
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE FUNCTION app_plan_visible(counterparty_plan_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_actor_present()
    AND EXISTS (
      SELECT 1 FROM public.plan p
      WHERE p.id = counterparty_plan_id
        AND public.app_circle_visible(p.host_circle_id)
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE FUNCTION app_application_visible(counterparty_application_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_actor_present()
    AND EXISTS (
      SELECT 1 FROM public.application a
      WHERE a.id = counterparty_application_id
        AND public.app_plan_visible(a.plan_id)
        AND (a.solo_user_id IS NULL OR public.app_user_visible(a.solo_user_id))
        AND (a.applicant_circle_id IS NULL OR public.app_circle_visible(a.applicant_circle_id))
        AND (
          a.solo_user_id = public.app_current_actor_id()
          OR EXISTS (
            SELECT 1 FROM public.application_member am
            WHERE am.application_id = a.id
              AND am.user_id = public.app_current_actor_id()
          )
          OR EXISTS (
            SELECT 1 FROM public.circle_member applicant_member
            WHERE applicant_member.circle_id = a.applicant_circle_id
              AND applicant_member.user_id = public.app_current_actor_id()
              AND applicant_member.status = 'active'
          )
          OR EXISTS (
            SELECT 1 FROM public.plan host_plan
            JOIN public.circle_member host_member
              ON host_member.circle_id = host_plan.host_circle_id
            WHERE host_plan.id = a.plan_id
              AND host_member.user_id = public.app_current_actor_id()
              AND host_member.status = 'active'
          )
        )
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION app_user_visible(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
ALTER FUNCTION app_circle_visible(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
ALTER FUNCTION app_plan_visible(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
ALTER FUNCTION app_application_visible(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_visible(varchar), app_circle_visible(varchar), app_plan_visible(varchar), app_application_visible(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_actor_id(), app_actor_present(), app_user_visible(varchar), app_circle_visible(varchar), app_plan_visible(varchar), app_application_visible(varchar) TO unlisted_app, unlisted_admin, unlisted_migrator;
--> statement-breakpoint

-- ENABLE + FORCE every entity table. Every app policy is false when the
-- transaction-local actor GUC is absent (or has reset to an empty string).
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY user_actor_scope ON "user" FOR ALL TO unlisted_app USING (app_actor_present() AND app_user_visible(id)) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE record ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE record FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY record_actor_scope ON record FOR ALL TO unlisted_app USING (app_actor_present() AND app_user_visible(user_id)) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE circle ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE circle FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY circle_actor_scope ON circle FOR ALL TO unlisted_app USING (app_actor_present() AND app_circle_visible(id)) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE circle_member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE circle_member FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY circle_member_actor_scope ON circle_member FOR ALL TO unlisted_app USING (app_actor_present() AND app_circle_visible(circle_id) AND app_user_visible(user_id)) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE venue ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE venue FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY venue_actor_scope ON venue FOR ALL TO unlisted_app USING (app_actor_present()) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE plan ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plan FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY plan_actor_scope ON plan FOR ALL TO unlisted_app USING (app_actor_present() AND app_plan_visible(id)) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE application ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE application FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY application_actor_scope ON application FOR ALL TO unlisted_app USING (app_actor_present() AND app_application_visible(id)) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE application_member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE application_member FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY application_member_actor_scope ON application_member FOR ALL TO unlisted_app USING (app_actor_present() AND app_application_visible(application_id) AND app_user_visible(user_id)) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE message_thread ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE message_thread FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY message_thread_actor_scope ON message_thread FOR ALL TO unlisted_app
  USING (app_actor_present() AND app_plan_visible(plan_id) AND EXISTS (
    SELECT 1 FROM circle_member thread_member
    WHERE thread_member.user_id = app_current_actor_id()
      AND thread_member.status = 'active'
      AND thread_member.circle_id IN (circle_a_id, circle_b_id)
  )) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE message ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE message FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY message_actor_scope ON message FOR ALL TO unlisted_app
  USING (app_actor_present() AND app_user_visible(sender_user_id) AND EXISTS (
    SELECT 1 FROM message_thread visible_thread WHERE visible_thread.id = thread_id
  )) WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE signal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE signal FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY signal_insert_scope ON signal FOR INSERT TO unlisted_app WITH CHECK (app_actor_present());
--> statement-breakpoint
ALTER TABLE block ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE block FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY block_actor_scope ON block FOR ALL TO unlisted_app
  USING (app_actor_present() AND (blocker_user_id = app_current_actor_id() OR blocked_user_id = app_current_actor_id()))
  WITH CHECK (app_actor_present() AND blocker_user_id = app_current_actor_id());
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_log_insert_scope ON audit_log FOR INSERT TO unlisted_app
  WITH CHECK (app_actor_present() AND (actor_id = app_current_actor_id() OR (actor_id IS NULL AND app_current_actor_id() LIKE 'system:%')));
--> statement-breakpoint

-- Ownership and privileges. unlisted_admin is the sole BYPASSRLS runtime role.
ALTER TABLE "user" OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE record OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE circle OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE circle_member OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE venue OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE plan OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE application OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE application_member OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE message_thread OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE message OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE signal OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE block OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE audit_log OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE verification_state OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE user_standing OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE circle_member_role OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE circle_member_status OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE venue_type OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE plan_state OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE mode OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE plan_cancellation_kind OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE application_state OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE application_member_confirmation_state OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE application_member_invitation_state OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE signal_kind OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TYPE audit_actor_role OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION set_updated_at() OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION enforce_plan_guards() OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION reject_audit_log_mutation() OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION app_current_actor_id() OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION app_actor_present() OWNER TO unlisted_migrator;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO unlisted_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO unlisted_admin;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM unlisted_app;
