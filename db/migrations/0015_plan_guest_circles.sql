-- C7c fix (todo_agent.md C7b + C7c): the guest-circle read for Decision C's
-- record counters must not depend on the caller's `application` visibility.
--
-- THE DEFECT THIS CLOSES
--
-- `completePlan` (db/plans.ts) banks `circle.plans_attended` for each distinct
-- guest circle holding an accepted (planned) / approved (tonight) application on
-- the completed plan. The counter UPDATEs already run as a system actor against
-- 0014's `circle_system_record_*` policies. But the SELECT that finds those
-- circles ran under the caller's actor via `application_app_read`
-- (`app_application_visible`). `completePlan` has no production caller yet;
-- E1's worker will be the first and will run as SYSTEM_ACTOR, for which
-- `app_application_visible` matches zero rows -- so `plans_attended` would
-- silently never accrue for anybody. That is one half of Decision A's tonight
-- hosting gate, so circle guests could never clear it.
--
-- Same silent-zero-row shape 0014 was written to close, one table over.
--
-- WHY SECURITY DEFINER (and why not a system read policy on `application`)
--
-- The read's correctness must not depend on the caller's visibility scope: the
-- caller may be a system actor with no `application` visibility, and a
-- visibility-scoped read here silently under-counts rather than failing loudly.
-- Same rationale, and same shape, as `app_active_host_member_count` (0011) and
-- the `app_actor_*` actor-scope predicates (0009 / 0013). A system read policy
-- on `application` would instead expose every application row to the system
-- actor; this function exposes exactly one plan's guest-circle ids.
--
-- `application` already exists with RLS ENABLE + FORCE and owner
-- unlisted_migrator (0002); everything here is additive.

-- Distinct guest circles with a live accepted/approved application on the plan.
-- SECURITY DEFINER, owned by unlisted_admin like `app_actor_leads_circle` /
-- `app_actor_is_application_party` so the scan is not narrowed by anybody's
-- block filter (unlisted_admin holds `application_admin_read USING (true)`,
-- 0004). STABLE; pinned search_path.
CREATE FUNCTION app_plan_guest_circle_ids(target_plan_id varchar(26))
  RETURNS SETOF varchar(26) AS $$
  SELECT DISTINCT a.applicant_circle_id
    FROM public.application a
   WHERE a.plan_id = target_plan_id
     AND a.applicant_circle_id IS NOT NULL
     AND (
       (a.mode = 'planned'  AND a.state = 'accepted')
       OR (a.mode = 'tonight' AND a.state = 'approved')
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION app_plan_guest_circle_ids(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_plan_guest_circle_ids(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_plan_guest_circle_ids(varchar) TO unlisted_app;
