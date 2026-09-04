-- A3 correction: durable introduction history and least-privilege runtime roles.

-- There is no safe inferred backfill: the pre-ledger schema did not retain the
-- exact people introduced by a prior viability crossing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.plan WHERE viable_at IS NOT NULL) THEN
    RAISE EXCEPTION 'pre-ledger viable plan exists; authoritative introduction history is required';
  END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE public.plan_participant_introduction
  ADD CONSTRAINT plan_participant_introduction_plan_viable_fk
  FOREIGN KEY (plan_id) REFERENCES public.plan (viable_plan_key);
--> statement-breakpoint

ALTER TABLE public.plan_participant_introduction OWNER TO unlisted_migrator;
--> statement-breakpoint

CREATE FUNCTION reject_plan_participant_introduction_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'plan_participant_introduction is append-only (% blocked)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE TRIGGER plan_participant_introduction_no_update
  BEFORE UPDATE ON public.plan_participant_introduction
  FOR EACH ROW EXECUTE FUNCTION reject_plan_participant_introduction_mutation();
--> statement-breakpoint
CREATE TRIGGER plan_participant_introduction_no_delete
  BEFORE DELETE ON public.plan_participant_introduction
  FOR EACH ROW EXECUTE FUNCTION reject_plan_participant_introduction_mutation();
--> statement-breakpoint

-- Local ULID generation for trigger-owned rows. The first ten characters encode
-- the millisecond timestamp and the final sixteen carry 80 random bits.
CREATE FUNCTION generate_introduction_ulid() RETURNS varchar(26) AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  time_value bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..10 LOOP
    result := substr(alphabet, (time_value % 32)::integer + 1, 1) || result;
    time_value := time_value / 32;
  END LOOP;
  FOR i IN 1..16 LOOP
    result := result || substr(alphabet, floor(random() * 32)::integer + 1, 1);
  END LOOP;
  RETURN result::varchar(26);
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog;
--> statement-breakpoint

-- This is the only population implementation. Its first data-bearing operation
-- locks the plan; viability and participant eligibility are evaluated afterward.
CREATE FUNCTION reconcile_plan_participant_introductions(
  target_plan_id varchar(26),
  introduction_time timestamptz DEFAULT clock_timestamp()
) RETURNS void AS $$
DECLARE
  latched_at timestamptz;
BEGIN
  SELECT p.viable_at
    INTO latched_at
    FROM public.plan p
   WHERE p.id = target_plan_id
   FOR UPDATE;

  IF NOT FOUND OR latched_at IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.plan_participant_introduction (id, plan_id, user_id, introduced_at)
  SELECT public.generate_introduction_ulid(), target_plan_id, confirmed.user_id,
         COALESCE(introduction_time, clock_timestamp())
    FROM (
      SELECT cm.user_id
        FROM public.plan p
        JOIN public.circle_member cm
          ON cm.circle_id = p.host_circle_id
         AND cm.status = 'active'
       WHERE p.id = target_plan_id

      UNION

      SELECT a.solo_user_id
        FROM public.application a
       WHERE a.plan_id = target_plan_id
         AND a.mode = 'planned'
         AND a.state = 'accepted'
         AND a.solo_user_id IS NOT NULL

      UNION

      SELECT am.user_id
        FROM public.application a
        JOIN public.application_member am ON am.application_id = a.id
       WHERE a.plan_id = target_plan_id
         AND a.mode = 'planned'
         AND a.state IN ('invited', 'accepted')
         AND a.applicant_circle_id IS NOT NULL
         AND am.invitation_state = 'accepted'

      UNION

      SELECT a.solo_user_id
        FROM public.application a
       WHERE a.plan_id = target_plan_id
         AND a.mode = 'tonight'
         AND a.state = 'approved'
         AND a.solo_user_id IS NOT NULL

      UNION

      SELECT am.user_id
        FROM public.application a
        JOIN public.application_member am ON am.application_id = a.id
       WHERE a.plan_id = target_plan_id
         AND a.mode = 'tonight'
         AND a.state = 'approved'
         AND a.applicant_circle_id IS NOT NULL
    ) confirmed
  ON CONFLICT (plan_id, user_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE FUNCTION reconcile_introductions_from_plan() RETURNS trigger AS $$
BEGIN
  IF NEW.viable_at IS NOT NULL THEN
    IF TG_OP = 'INSERT' OR OLD.viable_at IS NULL THEN
      PERFORM public.reconcile_plan_participant_introductions(NEW.id, NEW.viable_at);
    ELSE
      PERFORM public.reconcile_plan_participant_introductions(NEW.id, clock_timestamp());
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE TRIGGER plan_reconcile_participant_introductions
  AFTER INSERT OR UPDATE OF viable_at, confirmed_host_count, accepted_guest_count ON public.plan
  FOR EACH ROW EXECUTE FUNCTION reconcile_introductions_from_plan();
--> statement-breakpoint

CREATE FUNCTION reconcile_introductions_from_application() RETURNS trigger AS $$
BEGIN
  PERFORM public.reconcile_plan_participant_introductions(NEW.plan_id, clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE TRIGGER application_reconcile_participant_introductions
  AFTER INSERT OR UPDATE OF state ON public.application
  FOR EACH ROW EXECUTE FUNCTION reconcile_introductions_from_application();
--> statement-breakpoint

CREATE FUNCTION reconcile_introductions_from_application_member() RETURNS trigger AS $$
DECLARE
  target_plan_id varchar(26);
BEGIN
  -- Resolving the parent plan is not an eligibility check. The common function
  -- acquires the plan lock before it checks viability or selects participants.
  SELECT a.plan_id INTO target_plan_id
    FROM public.application a
   WHERE a.id = NEW.application_id;
  PERFORM public.reconcile_plan_participant_introductions(target_plan_id, clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE TRIGGER application_member_reconcile_participant_introductions
  AFTER INSERT OR UPDATE OF invitation_state ON public.application_member
  FOR EACH ROW EXECUTE FUNCTION reconcile_introductions_from_application_member();
--> statement-breakpoint

CREATE FUNCTION app_actor_hosts_circle(counterparty_circle_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_actor_present()
     AND EXISTS (
       SELECT 1 FROM public.circle_member cm
        WHERE cm.circle_id = counterparty_circle_id
          AND cm.user_id = public.app_current_actor_id()
          AND cm.status = 'active'
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_plan_visible(counterparty_plan_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_actor_present()
     AND EXISTS (
       SELECT 1 FROM public.plan p
        WHERE p.id = counterparty_plan_id
          AND (public.app_actor_hosts_circle(p.host_circle_id)
               OR public.app_circle_visible(p.host_circle_id))
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE FUNCTION app_shared_introduction_visible(subject_user_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_current_actor_id() IS NOT NULL
     AND public.app_current_actor_id() NOT LIKE 'system:%'
     AND EXISTS (
       SELECT 1
         FROM public.plan_participant_introduction actor_introduction
         JOIN public.plan_participant_introduction subject_introduction
           ON subject_introduction.plan_id = actor_introduction.plan_id
        WHERE actor_introduction.user_id = public.app_current_actor_id()
          AND subject_introduction.user_id = subject_user_id
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint

ALTER FUNCTION reject_plan_participant_introduction_mutation() OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION generate_introduction_ulid() OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION reconcile_plan_participant_introductions(varchar, timestamptz) OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION reconcile_introductions_from_plan() OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION reconcile_introductions_from_application() OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION reconcile_introductions_from_application_member() OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER FUNCTION app_actor_hosts_circle(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
ALTER FUNCTION app_shared_introduction_visible(varchar) OWNER TO unlisted_migrator;
--> statement-breakpoint

-- Replace the overly broad application policies from 0002.
DROP POLICY user_actor_scope ON public."user";
--> statement-breakpoint
DROP POLICY record_actor_scope ON public.record;
--> statement-breakpoint
DROP POLICY circle_actor_scope ON public.circle;
--> statement-breakpoint
DROP POLICY circle_member_actor_scope ON public.circle_member;
--> statement-breakpoint
DROP POLICY venue_actor_scope ON public.venue;
--> statement-breakpoint
DROP POLICY plan_actor_scope ON public.plan;
--> statement-breakpoint
DROP POLICY application_actor_scope ON public.application;
--> statement-breakpoint
DROP POLICY application_member_actor_scope ON public.application_member;
--> statement-breakpoint
DROP POLICY message_thread_actor_scope ON public.message_thread;
--> statement-breakpoint
DROP POLICY message_actor_scope ON public.message;
--> statement-breakpoint
DROP POLICY signal_insert_scope ON public.signal;
--> statement-breakpoint
DROP POLICY block_actor_scope ON public.block;
--> statement-breakpoint
DROP POLICY audit_log_insert_scope ON public.audit_log;
--> statement-breakpoint

CREATE POLICY user_app_read ON public."user" FOR SELECT TO unlisted_app
  USING (app_actor_present() AND app_user_visible(id));
--> statement-breakpoint
CREATE POLICY block_app_read ON public.block FOR SELECT TO unlisted_app
  USING (app_actor_present() AND (blocker_user_id = app_current_actor_id() OR blocked_user_id = app_current_actor_id()));
--> statement-breakpoint
CREATE POLICY circle_member_app_read ON public.circle_member FOR SELECT TO unlisted_app
  USING (app_actor_present() AND app_circle_visible(circle_id) AND app_user_visible(user_id));
--> statement-breakpoint
CREATE POLICY plan_app_read ON public.plan FOR SELECT TO unlisted_app
  USING (app_actor_present() AND app_plan_visible(id));
--> statement-breakpoint
CREATE POLICY application_app_read ON public.application FOR SELECT TO unlisted_app
  USING (app_actor_present() AND app_application_visible(id));
--> statement-breakpoint
CREATE POLICY application_member_app_read ON public.application_member FOR SELECT TO unlisted_app
  USING (app_actor_present() AND app_application_visible(application_id) AND app_user_visible(user_id));
--> statement-breakpoint

CREATE POLICY user_admin_read ON public."user" FOR SELECT TO unlisted_admin USING (true);
--> statement-breakpoint
CREATE POLICY block_admin_read ON public.block FOR SELECT TO unlisted_admin USING (true);
--> statement-breakpoint
CREATE POLICY circle_member_admin_read ON public.circle_member FOR SELECT TO unlisted_admin USING (true);
--> statement-breakpoint
CREATE POLICY plan_admin_read ON public.plan FOR SELECT TO unlisted_admin USING (true);
--> statement-breakpoint
CREATE POLICY application_admin_read ON public.application FOR SELECT TO unlisted_admin USING (true);
--> statement-breakpoint
CREATE POLICY application_member_admin_read ON public.application_member FOR SELECT TO unlisted_admin USING (true);
--> statement-breakpoint

ALTER TABLE public.plan_participant_introduction ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.plan_participant_introduction FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY plan_introduction_migrator_read ON public.plan_participant_introduction
  FOR SELECT TO unlisted_migrator USING (true);
--> statement-breakpoint
CREATE POLICY plan_introduction_migrator_insert ON public.plan_participant_introduction
  FOR INSERT TO unlisted_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY plan_migrator_population_read ON public.plan
  FOR SELECT TO unlisted_migrator USING (true);
--> statement-breakpoint
-- PostgreSQL applies UPDATE row policies to SELECT ... FOR UPDATE. This policy
-- permits the lock's existing-row check but its false WITH CHECK prevents the
-- function owner from changing any plan row.
CREATE POLICY plan_migrator_population_lock ON public.plan
  FOR UPDATE TO unlisted_migrator USING (true) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY circle_member_migrator_population_read ON public.circle_member
  FOR SELECT TO unlisted_migrator USING (true);
--> statement-breakpoint
CREATE POLICY application_migrator_population_read ON public.application
  FOR SELECT TO unlisted_migrator USING (true);
--> statement-breakpoint
CREATE POLICY application_member_migrator_population_read ON public.application_member
  FOR SELECT TO unlisted_migrator USING (true);
--> statement-breakpoint

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM unlisted_app, unlisted_admin;
--> statement-breakpoint
GRANT SELECT ON public."user", public.block, public.circle_member, public.plan,
  public.application, public.application_member TO unlisted_app, unlisted_admin;
--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, unlisted_app, unlisted_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_actor_id(), app_actor_present(),
  app_user_visible(varchar), app_circle_visible(varchar), app_plan_visible(varchar),
  app_application_visible(varchar), app_actor_hosts_circle(varchar)
  TO unlisted_app, unlisted_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_shared_introduction_visible(varchar) TO unlisted_app;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE unlisted_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM unlisted_app, unlisted_admin;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE unlisted_migrator IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, unlisted_app, unlisted_admin;
--> statement-breakpoint

ALTER ROLE unlisted_app WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD NULL;
--> statement-breakpoint
ALTER ROLE unlisted_admin WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD NULL;
--> statement-breakpoint
ALTER ROLE unlisted_migrator WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD NULL;
