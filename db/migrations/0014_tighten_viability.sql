-- C7b + C7c (todo_agent.md): tighten the viability predicate and let plan
-- completion bank the circle record counters.
--
-- Everything here is additive or a CREATE OR REPLACE. No table is created;
-- `plan` and `circle` already exist with RLS ENABLE + FORCE and owner
-- unlisted_migrator (0002).
--
-- THREE CHANGES
--
-- 1. Decision B (docs/state.md Decisions C7b + C7c): a plan is viable only when
--    confirmed_host_count + accepted_guest_count >= MIN_PLAN_TOTAL AND there is
--    at least one accepted guest. A 3-host / 0-guest plan is a host circle
--    meeting itself, not a plan that came together. This is strictly stricter
--    than docs/modes.md's rule -- it never weakens the invariant. It reverses
--    the C3 decision that latched viable_at at publish for a host-only circle.
--    enforce_plan_guards() (0001) gains `OR NEW.accepted_guest_count < 1` in the
--    set-time floor. CREATE OR REPLACE preserves the function's identity and
--    owner, so the existing `plan_enforce_guards` trigger and the
--    function-inventory tests are unaffected. The rest of the body is copied
--    from 0001_guards.sql verbatim.
--
-- 2. Decision C: `completePlan` (db/plans.ts) banks circle.plans_hosted for the
--    host circle and circle.plans_attended for each distinct guest circle
--    holding an accepted (planned) / approved (tonight) application. This grant
--    is column-scoped to exactly those two counters -- no_shows / late_declines
--    stay un-grantable (signal-class).
--
-- 3. The record-counter write is a system-actor write: a guest circle is
--    neither led by nor visible to the completing host lead, so
--    circle_app_read / circle_app_update (0009) match zero rows for it. A
--    system-actor SELECT + UPDATE policy pair (the 0008
--    user_system_verification_write precedent) makes the write land. A
--    monotonic-growth WITH CHECK would need OLD, which a policy WITH CHECK
--    cannot see -- deliberately not added (the single writer under the plan row
--    lock, plus the column grant, keeps the counters honest).

--------------------------------------------------------------------------------
-- 1. enforce_plan_guards(): Decision B set-time floor.
--    Copied verbatim from 0001_guards.sql; the ONLY change is the added
--    `OR NEW.accepted_guest_count < 1` disjunct in the set-time floor. The
--    MIN_PLAN_TOTAL annotation on the `3` is kept exactly as in 0001 (the unit
--    test tests/unit/migration-min-plan-total.test.ts checks every annotated
--    occurrence equals lib/config.ts). The `1` is a bare structural literal --
--    an "at least one other group" floor, not a tunable -- so no annotation.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_plan_guards() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- mode is derived once, at publish, then immutable (docs/modes.md).
    IF OLD.mode IS NOT NULL AND NEW.mode IS DISTINCT FROM OLD.mode THEN
      RAISE EXCEPTION 'plan.mode is immutable once set (plan %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- viable_at latches: "introduction has occurred" cannot be undone.
    IF OLD.viable_at IS NOT NULL AND NEW.viable_at IS NULL THEN
      RAISE EXCEPTION 'plan.viable_at cannot be cleared once set (plan %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- viable_at may only be stamped when the counters justify it at that moment.
  -- (A later withdrawal may legitimately drop confirmed_total below the floor
  -- while viable_at stays set -- that case is allowed.)
  -- Decision B (C7b + C7c): additionally require at least one accepted guest --
  -- a host circle alone can never latch viability.
  IF NEW.viable_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.viable_at IS NULL)
     AND (
       (NEW.confirmed_host_count + NEW.accepted_guest_count)
         < 3 /* MIN_PLAN_TOTAL: keep equal to lib/config.ts */
       OR NEW.accepted_guest_count < 1
     ) THEN
    RAISE EXCEPTION 'plan.viable_at set below MIN_PLAN_TOTAL or with no accepted guest (plan %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. circle record counters: column-scoped UPDATE grant (Decision C).
--------------------------------------------------------------------------------
GRANT UPDATE (plans_hosted, plans_attended) ON public.circle TO unlisted_app;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 3. system-actor SELECT + UPDATE policies on circle, so completePlan's
--    record-counter write reaches a guest circle the completing actor neither
--    leads nor can see. Gated on app_current_actor_id() LIKE 'system:%' on both
--    sides (USING for the pre-image, WITH CHECK for the post-image), so a real
--    user-actor transaction can never satisfy them regardless of grants. RLS
--    policies combine permissively, so these are additive to circle_app_read /
--    circle_app_update (0009); non-system actors gain nothing.
--------------------------------------------------------------------------------
CREATE POLICY circle_system_record_read ON public.circle FOR SELECT TO unlisted_app
  USING (app_current_actor_id() LIKE 'system:%');
--> statement-breakpoint
CREATE POLICY circle_system_record_write ON public.circle FOR UPDATE TO unlisted_app
  USING (app_current_actor_id() LIKE 'system:%')
  WITH CHECK (app_current_actor_id() LIKE 'system:%');
