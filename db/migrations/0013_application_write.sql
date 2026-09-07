-- C5 + C6 + C7a (todo_agent.md): the apply -> review -> invite -> accept flow.
-- Opens the write surface for `application` / `application_member` (SELECT-only
-- since 0004's six-table replacement grant) and lets the two guest-capacity
-- counters on `plan` move on the invitation/acceptance path -- the columns
-- 0011 deliberately withheld from C3.
--
-- Everything here is additive. `application`, `application_member`, `plan` all
-- exist with RLS ENABLE + FORCE and owner unlisted_migrator (0002). The 0001
-- row-level guards on `plan` (mode immutability, viable_at latch, viable_at
-- set-time floor), the generated `confirmed_total` column, and the DB CHECK
-- `plan_capacity_ceiling_chk` (accepted_guest_count + held_count <= open_spots)
-- are untouched -- they are the database backstop under domain/plan.ts and
-- domain/application-planned.ts, not logic re-implemented here.
--
-- WHAT 0013 CHANGES ABOUT THE 0011 GUARANTEE (recorded in docs/state.md
-- Decisions C7a): 0011's comment claims "a C3 bug cannot touch guest
-- capacity" because accepted_guest_count / held_count were un-grantable. 0013
-- grants them (column-scoped) to unlisted_app, because the *invitee* -- not the
-- host lead -- runs the accept that moves them. Privilege alone no longer
-- separates the capacity path from the lifecycle path within unlisted_app.
-- Three things separate them instead:
--   1. the column grant is exactly (accepted_guest_count, held_count) -- no
--      other new column on `plan`;
--   2. `plan_enforce_capacity_scope` (below), a BEFORE UPDATE trigger that
--      rejects any change to a lifecycle column when the acting role is not the
--      host circle's active lead -- RLS cannot see the SET list, so the trigger
--      is what confines a capacity-path actor to the counter columns;
--   3. all raw SQL stays in db/applications.ts / db/invitations.ts
--      (TRUSTED_DATABASE_FILES), each routing every counter change through the
--      A6 reducer under the plan row lock.
-- `plan_capacity_ceiling_chk` is therefore now the LAST line of defence
-- against an overshoot, not the third -- tests exercise the CHECK directly.

-- ---------------------------------------------------------------------------
-- Helper predicates (SECURITY DEFINER, owned by unlisted_admin like
-- app_actor_leads_circle / app_actor_hosts_circle so they see the true rows
-- past the caller's block filter; pinned search_path).
-- ---------------------------------------------------------------------------

-- Is the current actor the party that owns this application -- the solo user,
-- or the active lead of the applicant circle. This is the "invitee" for
-- POST /invitations/:id/accept | /decline and the writer for the confirm /
-- withdraw-member member rows.
CREATE FUNCTION app_actor_is_application_party(counterparty_application_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_actor_present()
     AND EXISTS (
       SELECT 1 FROM public.application a
        WHERE a.id = counterparty_application_id
          AND (
            a.solo_user_id = public.app_current_actor_id()
            OR (a.applicant_circle_id IS NOT NULL
                AND public.app_actor_leads_circle(a.applicant_circle_id))
          )
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION app_actor_is_application_party(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_actor_is_application_party(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_actor_is_application_party(varchar) TO unlisted_app, unlisted_admin;
--> statement-breakpoint

-- May the current actor UPDATE this plan's guest-capacity counters: the host
-- circle's active lead (places / holds), or a party to an invited/accepted
-- planned application on the plan (accepts / declines its own hold). Backs
-- `plan_app_capacity_update`. Terminal-state applications are intentionally
-- excluded from the stake set -- db/invitations.ts orders its two writes so
-- the application is still `invited` while the plan UPDATE runs (see its
-- comments), which keeps this set tight.
CREATE FUNCTION app_actor_has_capacity_stake_in_plan(counterparty_plan_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_actor_present()
     AND (
       public.app_actor_leads_circle(
         (SELECT p.host_circle_id FROM public.plan p WHERE p.id = counterparty_plan_id)
       )
       OR EXISTS (
         SELECT 1 FROM public.application a
          WHERE a.plan_id = counterparty_plan_id
            AND a.mode = 'planned'
            AND a.state IN ('invited', 'accepted')
            AND (
              a.solo_user_id = public.app_current_actor_id()
              OR (a.applicant_circle_id IS NOT NULL
                  AND public.app_actor_leads_circle(a.applicant_circle_id))
            )
       )
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION app_actor_has_capacity_stake_in_plan(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_actor_has_capacity_stake_in_plan(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_actor_has_capacity_stake_in_plan(varchar) TO unlisted_app, unlisted_admin;
--> statement-breakpoint

-- "Does this user already hold an accepted spot on a plan whose time overlaps
-- [window_start, window_end)?" -- the C7a rule "no user holds two accepted
-- invitations for overlapping time windows" (docs/api.md Invitations,
-- docs/architecture.md domain invariants). Half-open interval overlap:
-- other.start < window.end AND window.start < other.end. A null ends_at is
-- treated as instantaneous (COALESCE to starts_at) -- flagged as a precision
-- limit in docs/state.md; a real assumed duration would be a section-5 config
-- change. SECURITY DEFINER so the scan is not narrowed by the acting invitee's
-- own block filter on the other plans' host circles.
CREATE FUNCTION app_user_has_overlapping_accepted_plan(
  subject_user_id varchar(26),
  window_start timestamptz,
  window_end timestamptz,
  exclude_application_id varchar(26)
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.application a
      JOIN public.plan p ON p.id = a.plan_id
      LEFT JOIN public.application_member am
        ON am.application_id = a.id AND am.user_id = subject_user_id
     WHERE a.id <> exclude_application_id
       AND (
         (a.mode = 'planned' AND a.state = 'accepted')
         OR (a.mode = 'tonight' AND a.state = 'approved')
       )
       AND (
         a.solo_user_id = subject_user_id
         OR (am.user_id = subject_user_id AND am.invitation_state = 'accepted')
       )
       AND p.starts_at < COALESCE(window_end, window_start)
       AND COALESCE(p.ends_at, p.starts_at) > window_start
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION app_user_has_overlapping_accepted_plan(varchar, timestamptz, timestamptz, varchar)
  OWNER TO unlisted_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_has_overlapping_accepted_plan(varchar, timestamptz, timestamptz, varchar)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_has_overlapping_accepted_plan(varchar, timestamptz, timestamptz, varchar)
  TO unlisted_app, unlisted_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The capacity-scope guard trigger.
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (like 0001's enforce_plan_guards): it only compares NEW/OLD
-- and calls app_* helpers that unlisted_app already holds EXECUTE on. When no
-- actor GUC is set (a superuser test writing directly, or a system actor) it
-- passes through -- those paths are not the invitee capacity path this guards.
CREATE FUNCTION enforce_plan_capacity_scope() RETURNS trigger AS $$
BEGIN
  IF public.app_current_actor_id() IS NULL
     OR public.app_current_actor_id() LIKE 'system:%'
     OR public.app_actor_leads_circle(OLD.host_circle_id) THEN
    RETURN NEW;
  END IF;

  -- A non-host-lead actor (the invitee, via plan_app_capacity_update) may
  -- change only accepted_guest_count / held_count / viable_at. Any other
  -- column moving means a lifecycle write reached this row through the
  -- capacity policy -- reject it.
  IF NEW.host_circle_id       IS DISTINCT FROM OLD.host_circle_id
   OR NEW.venue_id             IS DISTINCT FROM OLD.venue_id
   OR NEW.district             IS DISTINCT FROM OLD.district
   OR NEW.venue_type           IS DISTINCT FROM OLD.venue_type
   OR NEW.starts_at            IS DISTINCT FROM OLD.starts_at
   OR NEW.ends_at              IS DISTINCT FROM OLD.ends_at
   OR NEW.open_spots           IS DISTINCT FROM OLD.open_spots
   OR NEW.min_group_size       IS DISTINCT FROM OLD.min_group_size
   OR NEW.note                 IS DISTINCT FROM OLD.note
   OR NEW.state                IS DISTINCT FROM OLD.state
   OR NEW.mode                 IS DISTINCT FROM OLD.mode
   OR NEW.published_at         IS DISTINCT FROM OLD.published_at
   OR NEW.completed_at         IS DISTINCT FROM OLD.completed_at
   OR NEW.cancelled_at         IS DISTINCT FROM OLD.cancelled_at
   OR NEW.cancellation_kind    IS DISTINCT FROM OLD.cancellation_kind
   OR NEW.applications_closed_at IS DISTINCT FROM OLD.applications_closed_at
   OR NEW.confirmed_host_count IS DISTINCT FROM OLD.confirmed_host_count
  THEN
    RAISE EXCEPTION 'plan capacity path may change only accepted_guest_count / held_count / viable_at (plan %)', NEW.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION enforce_plan_capacity_scope() OWNER TO unlisted_migrator;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enforce_plan_capacity_scope() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER plan_enforce_capacity_scope
  BEFORE UPDATE ON public.plan
  FOR EACH ROW EXECUTE FUNCTION enforce_plan_capacity_scope();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------

-- application: create (any column, guarded by the WITH CHECK policy + the 0000
-- mode/state CHECKs); UPDATE only the lifecycle-relevant columns. plan_id /
-- applicant_circle_id / solo_user_id / mode / created_at stay un-grantable, so
-- an application cannot be re-pointed at another plan or re-moded after create.
GRANT INSERT ON public.application TO unlisted_app;
--> statement-breakpoint
GRANT UPDATE (state, note, response_deadline, submitted_at, decided_at, withdrawn_at)
  ON public.application TO unlisted_app;
--> statement-breakpoint

-- application_member: create + delete member rows (compose the circle, and
-- withdraw-member); UPDATE the confirmation / invitation columns. application_id
-- / user_id stay un-grantable.
GRANT INSERT, DELETE ON public.application_member TO unlisted_app;
--> statement-breakpoint
GRANT UPDATE (confirmation_state, confirmed_version_hash, invitation_state, hold_expires_at)
  ON public.application_member TO unlisted_app;
--> statement-breakpoint

-- plan: the two guest-capacity counters, and nothing else new. Combined with
-- plan_enforce_capacity_scope above, this is the whole of what the invitation /
-- acceptance path can do to a plan row.
GRANT UPDATE (accepted_guest_count, held_count) ON public.plan TO unlisted_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS write policies. The read policies (application_app_read /
-- application_member_app_read, 0004) are unchanged. Route handlers call
-- policy() for the real authorization (lead-only where required); these
-- policies are the "actor can see this application" backstop, plus the
-- create-time ownership check.
-- ---------------------------------------------------------------------------

-- Create an application only for a plan you can see, as the solo applicant or
-- the active lead of the applicant circle.
CREATE POLICY application_app_insert ON public.application FOR INSERT TO unlisted_app
  WITH CHECK (
    app_actor_present()
    AND app_plan_visible(plan_id)
    AND (
      solo_user_id = app_current_actor_id()
      OR (applicant_circle_id IS NOT NULL AND app_actor_leads_circle(applicant_circle_id))
    )
  );
--> statement-breakpoint

-- UPDATE an application you can see. app_application_visible (0002) already
-- admits the solo user, an applicant member, an active applicant-circle member,
-- AND any active host-circle member -- so this one policy covers both the
-- applicant-side writes (submit / withdraw / accept / decline) and the
-- host-side writes (shortlist / unshortlist / reject / invite). Also gates
-- SELECT ... FOR UPDATE on `application`.
CREATE POLICY application_app_update ON public.application FOR UPDATE TO unlisted_app
  USING (app_actor_present() AND app_application_visible(id))
  WITH CHECK (app_actor_present() AND app_application_visible(id));
--> statement-breakpoint

-- Insert member rows only for an application you own (compose the circle at
-- apply time). Solo applications have no member rows.
CREATE POLICY application_member_app_insert ON public.application_member FOR INSERT TO unlisted_app
  WITH CHECK (app_actor_present() AND app_actor_is_application_party(application_id));
--> statement-breakpoint

-- UPDATE a member row of an application you can see: a member confirming their
-- own row, the applicant lead editing the circle, or the host lead writing
-- invitation_state on invite. The handlers scope the WHERE precisely (confirm
-- only ever touches the actor's own row).
CREATE POLICY application_member_app_update ON public.application_member FOR UPDATE TO unlisted_app
  USING (app_actor_present() AND app_application_visible(application_id))
  WITH CHECK (app_actor_present() AND app_application_visible(application_id));
--> statement-breakpoint

-- Delete only your own member row (POST /applications/:id/withdraw-member --
-- "the member themselves", docs/api.md).
CREATE POLICY application_member_app_delete ON public.application_member FOR DELETE TO unlisted_app
  USING (app_actor_present() AND user_id = app_current_actor_id());
--> statement-breakpoint

-- The plan guest-capacity write path: host lead, or an invited/accepted
-- application's party. plan_enforce_capacity_scope confines the latter to the
-- counter columns; 0011's plan_app_update (host-lead, broad columns) still
-- exists and combines permissively, but a non-host-lead passing this policy
-- for the row is stopped by the trigger on any lifecycle column.
CREATE POLICY plan_app_capacity_update ON public.plan FOR UPDATE TO unlisted_app
  USING (app_actor_present() AND app_actor_has_capacity_stake_in_plan(id))
  WITH CHECK (app_actor_present() AND app_actor_has_capacity_stake_in_plan(id));
