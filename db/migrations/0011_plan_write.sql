-- C3 (todo_agent.md): plan write access for unlisted_app — draft creation,
-- publish, edit, cancel, manual application closure, plus the persist paths
-- E1's worker will call for completion / closure at starts_at. Before this
-- migration unlisted_app has SELECT-only on `plan` (0004_a3_corrections.sql's
-- six-table replacement grant); it cannot INSERT or UPDATE a plan row at all.
-- Everything here is additive.
--
-- `plan` already exists with RLS ENABLE + FORCE and owner unlisted_migrator
-- (0002_rls.sql). The row-level guards in 0001_guards.sql — mode immutability,
-- the viable_at latch, the viable_at set-time floor — and the generated
-- `confirmed_total` column are untouched: they are the database backstop that
-- domain/plan.ts's decisions sit in front of, not something C3 re-implements.
--
-- Follows the 0009 precedent: narrow, column-scoped grants; RLS policies that
-- mirror db/scope/visibility.ts and reuse C1's app_actor_leads_circle helper as
-- the single source of truth for "who may write this plan" — the host circle's
-- active lead. Nothing here reads plan.host_circle_id back to authorize; a
-- demoted lead loses write access because app_actor_leads_circle reads
-- circle_member(role='lead', status='active'), not any denormalized copy.

-- "Host size" for publish feasibility and the viability latch is the TRUE
-- count of active host-circle members (docs/state.md, recorded A3 decision) —
-- not the actor-visible count. unlisted_app reads circle_member under RLS that
-- applies app_user_visible(), so a host who has blocked a co-host would
-- otherwise under-count their own circle and mis-latch viability, a structural
-- safety invariant. This SECURITY DEFINER counter bypasses that filter, exactly
-- as app_actor_leads_circle (0009) does for the lead check. STABLE; pinned
-- search_path; owned by unlisted_admin like its siblings.
CREATE FUNCTION app_active_host_member_count(counterparty_circle_id varchar(26)) RETURNS integer AS $$
  SELECT count(*)::integer
    FROM public.circle_member cm
   WHERE cm.circle_id = counterparty_circle_id
     AND cm.status = 'active'
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION app_active_host_member_count(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_active_host_member_count(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_active_host_member_count(varchar) TO unlisted_app, unlisted_admin;
--> statement-breakpoint

-- plan INSERT: POST /plans. The creator must be the active lead of the named
-- host circle (a circle they just created via C1, so the lead row exists).
CREATE POLICY plan_app_insert ON public.plan FOR INSERT TO unlisted_app
  WITH CHECK (app_actor_present() AND app_actor_leads_circle(host_circle_id));
--> statement-breakpoint

-- plan UPDATE: publish / edit / cancel / close / (E1) complete. USING gates the
-- existing row on the current host lead; WITH CHECK repeats it. host_circle_id
-- is not in the column grant below, so the lead cannot be moved out from under
-- the check. The BEFORE INSERT/UPDATE guards in 0001_guards.sql still run on
-- top of this policy.
CREATE POLICY plan_app_update ON public.plan FOR UPDATE TO unlisted_app
  USING (app_actor_present() AND app_actor_leads_circle(host_circle_id))
  WITH CHECK (app_actor_present() AND app_actor_leads_circle(host_circle_id));
--> statement-breakpoint

GRANT INSERT ON public.plan TO unlisted_app;
--> statement-breakpoint

-- Column-scoped UPDATE: exactly the columns C3's transitions write. Absent by
-- design: host_circle_id (immutable host); accepted_guest_count / held_count
-- (moved only by the C5/C7 acceptance and invitation flows — their migration
-- adds those grants, so a C3 bug cannot touch guest capacity); created_at; and
-- the generated confirmed_total. `has_table_privilege(..., 'UPDATE')` stays
-- false for a column-scoped grant, same as the 0008 / 0009 verification and
-- circle grants.
GRANT UPDATE (
  state, mode, published_at, completed_at, cancelled_at, cancellation_kind,
  applications_closed_at, viable_at, confirmed_host_count,
  venue_id, starts_at, ends_at, open_spots, min_group_size, note,
  district, venue_type
) ON public.plan TO unlisted_app;
--> statement-breakpoint

-- Finding (docs/state.md Decisions C3): domain/plan.ts's `transitionPlan`
-- allows `cancel` from `draft` (recorded A6 decision, tested since A6), but the
-- frozen 0000 constraint `plan_mode_set_after_draft_chk` — `state = 'draft' OR
-- mode IS NOT NULL` — makes any non-draft row without a `mode` impossible, so a
-- draft cancelled before it was ever published cannot be persisted. A plan
-- cancelled pre-publish legitimately never received a mode. Relax the
-- constraint to also permit `cancelled` with a null mode; every other non-draft
-- state still requires `mode` (it is only reachable via publish, which sets
-- it). This supersedes the 0000 constraint the same way 0004 superseded 0002's
-- policies — 0000 itself is untouched.
ALTER TABLE public.plan DROP CONSTRAINT plan_mode_set_after_draft_chk;
--> statement-breakpoint
ALTER TABLE public.plan ADD CONSTRAINT plan_mode_set_after_draft_chk
  CHECK (state IN ('draft', 'cancelled') OR mode IS NOT NULL);
