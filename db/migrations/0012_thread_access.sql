-- C8 (todo_agent.md): message-thread read/post access, and the schema rework
-- that makes the thread model fit the two-mode design. User-authorized before
-- any code (agent-rules §6/§7); the reasoning is recorded in docs/state.md
-- Decisions C8 and as an explicit §3 exception.
--
-- WHY THE TWO CIRCLE COLUMNS GO
--
-- `message_thread` was circle-to-circle (data-model.md, pre-two-mode):
-- `circle_a_id` / `circle_b_id`, both NOT NULL, `<>` each other. But
-- MIN_HOST_CIRCLE = 1 makes circles of one legal, and an application is
-- `applicant_circle_id` XOR `solo_user_id` — a solo applicant has no circle.
-- So a viable plan of {1 host, 2 solo guests}, or {3 hosts, 0 guests} (C3
-- ships this), has one circle and cannot store its thread, even though
-- viability is supposed to open one.
--
-- The two-circle rule was never the anti-dyad guarantee: two distinct
-- circles of one member each satisfy `circle_a_id <> circle_b_id` perfectly
-- and are a two-person thread. The only structural bars to a dyad have always
-- been `message_thread_min_participants_chk` (participant_count >= 3) and the
-- FK to `plan.viable_plan_key` (which the set-time floor in enforce_plan_guards
-- only lets exist for a plan whose confirmed_total was >= 3). Dropping the
-- circle columns removes a constraint that was decorative for the invariant
-- and actively wrong for the two-mode design. The thread becomes plan-scoped
-- with its participant set taken from `plan_participant_introduction`.
--
-- WHAT KEEPS `>= 3` STRUCTURAL AFTER THE DROP
--
-- With the circle columns gone the whole anti-dyad guarantee rests on
-- `participant_count`, a denormalised integer. So this migration makes it
-- trigger-maintained from `plan_participant_introduction` — the same shape as
-- `reconcile_plan_participant_introductions` maintaining the ledger and
-- `confirmed_total` being generated. The application never sets it; `>= 3` is
-- a property of the data again, not a number a future caller is trusted to get
-- right. The ledger is append-only (reject_plan_participant_introduction_mutation),
-- so participant_count only ever grows — matching the `viable_at` latch: an
-- introduction is permanent.

-- Carried over from C3's known gaps: app_active_host_member_count reads the
-- circle_member table to see the TRUE membership, exactly like the population
-- functions — so it belongs with them under unlisted_migrator, not
-- unlisted_admin (whose policy set a later migration could narrow, silently
-- under-counting). See docs/state.md Known gaps C3. Changing the owner also
-- drops the old owner's (unlisted_admin's) EXECUTE grant from the ACL; that is
-- fine — nothing admin-side calls this, C3's only caller runs as unlisted_app —
-- and the app grant is re-asserted below to be explicit about it.
ALTER FUNCTION app_active_host_member_count(varchar) OWNER TO unlisted_migrator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_active_host_member_count(varchar) TO unlisted_app;
--> statement-breakpoint

-- Remove the circle-to-circle apparatus (all from 0000_init.sql).
ALTER TABLE public.message_thread DROP CONSTRAINT message_thread_distinct_circles_chk;
--> statement-breakpoint
ALTER TABLE public.message_thread DROP CONSTRAINT message_thread_circle_a_id_circle_id_fk;
--> statement-breakpoint
ALTER TABLE public.message_thread DROP CONSTRAINT message_thread_circle_b_id_circle_id_fk;
--> statement-breakpoint
DROP INDEX public.message_thread_circle_a_idx;
--> statement-breakpoint
DROP INDEX public.message_thread_circle_b_idx;
--> statement-breakpoint
ALTER TABLE public.message_thread DROP COLUMN circle_a_id;
--> statement-breakpoint
ALTER TABLE public.message_thread DROP COLUMN circle_b_id;
--> statement-breakpoint

-- Exactly one thread per plan (was a non-unique index in 0000).
DROP INDEX public.message_thread_plan_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX message_thread_plan_uq ON public.message_thread (plan_id);
--> statement-breakpoint

-- The ledger count for a plan. SECURITY DEFINER because
-- plan_participant_introduction is FORCE-RLS and readable only by
-- unlisted_migrator (0004's plan_introduction_migrator_read); pinned
-- search_path; owned by unlisted_migrator like the other population helpers.
-- Called only from the two trigger functions below, both of which are
-- themselves SECURITY DEFINER as migrator — the app never calls this directly,
-- so it gets no app EXECUTE grant.
-- VOLATILE, not STABLE: it is called from the AFTER INSERT trigger below, and a
-- STABLE function there would use the triggering statement's snapshot and miss
-- the ledger row that just fired the trigger.
CREATE FUNCTION message_thread_ledger_count(target_plan_id varchar(26)) RETURNS integer AS $$
  SELECT count(*)::integer
    FROM public.plan_participant_introduction ppi
   WHERE ppi.plan_id = target_plan_id
$$ LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION message_thread_ledger_count(varchar) OWNER TO unlisted_migrator;
--> statement-breakpoint
REVOKE ALL ON FUNCTION message_thread_ledger_count(varchar) FROM PUBLIC;
--> statement-breakpoint

-- On thread creation, participant_count is taken from the ledger, not from
-- whatever the inserter passed. BEFORE INSERT so the value is set before the
-- `>= 3` CHECK and the INSERT's own RLS WITH CHECK run.
CREATE FUNCTION set_message_thread_participant_count() RETURNS trigger AS $$
BEGIN
  NEW.participant_count := public.message_thread_ledger_count(NEW.plan_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION set_message_thread_participant_count() OWNER TO unlisted_migrator;
--> statement-breakpoint
REVOKE ALL ON FUNCTION set_message_thread_participant_count() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER message_thread_set_participant_count
  BEFORE INSERT ON public.message_thread
  FOR EACH ROW EXECUTE FUNCTION set_message_thread_participant_count();
--> statement-breakpoint

-- When the ledger grows for a plan that already has a thread, resync the
-- thread's participant_count. Append-only ledger => count only ever rises.
CREATE FUNCTION reconcile_thread_participant_count() RETURNS trigger AS $$
BEGIN
  UPDATE public.message_thread
     SET participant_count = public.message_thread_ledger_count(NEW.plan_id)
   WHERE plan_id = NEW.plan_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION reconcile_thread_participant_count() OWNER TO unlisted_migrator;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reconcile_thread_participant_count() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER plan_participant_introduction_resync_thread_count
  AFTER INSERT ON public.plan_participant_introduction
  FOR EACH ROW EXECUTE FUNCTION reconcile_thread_participant_count();
--> statement-breakpoint
-- message_thread is FORCE-RLS with no migrator policy (0002's was dropped by
-- 0004); the resync UPDATE above runs as unlisted_migrator. An UPDATE with a
-- WHERE clause needs a SELECT policy to find the row AND an UPDATE policy to
-- change it, so migrator gets both, USING (true). These are the only migrator
-- policies on message_thread — the retention worker's DELETE path is E2's.
CREATE POLICY message_thread_migrator_read ON public.message_thread
  FOR SELECT TO unlisted_migrator USING (true);
--> statement-breakpoint
CREATE POLICY message_thread_migrator_participant_count ON public.message_thread
  FOR UPDATE TO unlisted_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint

-- "Is the current actor a confirmed participant of this plan" — the read/post
-- gate. Mirrors app_shared_introduction_visible (0004) but per-plan and for
-- the current actor only. SECURITY DEFINER over the migrator-only ledger;
-- owned by unlisted_migrator; the app can only ask the boolean, never
-- enumerate rows.
CREATE FUNCTION app_thread_participant(counterparty_plan_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_current_actor_id() IS NOT NULL
     AND public.app_current_actor_id() NOT LIKE 'system:%'
     AND EXISTS (
       SELECT 1 FROM public.plan_participant_introduction ppi
        WHERE ppi.plan_id = counterparty_plan_id
          AND ppi.user_id = public.app_current_actor_id()
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION app_thread_participant(varchar) OWNER TO unlisted_migrator;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_thread_participant(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_thread_participant(varchar) TO unlisted_app;
--> statement-breakpoint

-- message_thread: unlisted_app may read a thread only for a plan it can see
-- AND on which it is a confirmed participant, and may create one only where it
-- is a participant (the FK to plan.viable_plan_key already forces viability).
-- No UPDATE / DELETE grant: participant_count is trigger-maintained, retention
-- is E2. unlisted_admin gets nothing — no admin path reads threads.
GRANT SELECT, INSERT ON public.message_thread TO unlisted_app;
--> statement-breakpoint
CREATE POLICY message_thread_app_read ON public.message_thread FOR SELECT TO unlisted_app
  USING (
    app_actor_present()
    AND app_plan_visible(plan_id)
    AND app_thread_participant(plan_id)
  );
--> statement-breakpoint
CREATE POLICY message_thread_app_insert ON public.message_thread FOR INSERT TO unlisted_app
  WITH CHECK (app_actor_present() AND app_thread_participant(plan_id));
--> statement-breakpoint

-- message: read a message when you may read its thread and its sender is
-- visible to you (a blocked co-participant's messages drop out here, in SQL).
-- Post only as yourself, into a thread you participate in.
GRANT SELECT, INSERT ON public.message TO unlisted_app;
--> statement-breakpoint
CREATE POLICY message_app_read ON public.message FOR SELECT TO unlisted_app
  USING (
    app_actor_present()
    AND app_user_visible(sender_user_id)
    AND EXISTS (
      SELECT 1 FROM public.message_thread mt
       WHERE mt.id = thread_id
         AND app_plan_visible(mt.plan_id)
         AND app_thread_participant(mt.plan_id)
    )
  );
--> statement-breakpoint
CREATE POLICY message_app_insert ON public.message FOR INSERT TO unlisted_app
  WITH CHECK (
    app_actor_present()
    AND sender_user_id = app_current_actor_id()
    AND EXISTS (
      SELECT 1 FROM public.message_thread mt
       WHERE mt.id = thread_id
         AND app_thread_participant(mt.plan_id)
    )
  );
