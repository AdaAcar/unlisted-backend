-- C1 (todo_agent.md): circle read access, and circle / circle_member write
-- access, for unlisted_app. Before this migration unlisted_app cannot touch
-- `circle` at all (0004_a3_corrections.sql dropped 0002's `circle_actor_scope`
-- and its six-table replacement grant omits `circle`), and has SELECT-only on
-- `circle_member`. Everything here is additive: 0004's
-- `REVOKE ALL PRIVILEGES ON ALL TABLES` and its `ALTER DEFAULT PRIVILEGES`
-- already left both tables at zero app privileges beyond the 0004 six-table
-- SELECT surface.
--
-- Follows the 0006/0007/0008 precedent: narrow, column-scoped, explicitly
-- justified grants; RLS policies that mirror db/scope/visibility.ts (the
-- authored source). No table is created; `circle` and `circle_member` already
-- exist with RLS ENABLE + FORCE and owner unlisted_migrator (0002_rls.sql).

-- The "who leads this circle" predicate, mirroring 0004's
-- `app_actor_hosts_circle` ("is an active member") but narrowed to the lead
-- role. SECURITY DEFINER so it can read circle_member under FORCE RLS; STABLE;
-- pinned search_path. This is the single source of truth for lead
-- authorization: no policy here reads `circle.lead_user_id`, because that
-- column is denormalized and a demoted lead must not retain write authority
-- through it. `circle_one_active_lead` (below) keeps this predicate
-- single-valued.
CREATE FUNCTION app_actor_leads_circle(counterparty_circle_id varchar(26)) RETURNS boolean AS $$
  SELECT public.app_actor_present()
     AND EXISTS (
       SELECT 1 FROM public.circle_member cm
        WHERE cm.circle_id = counterparty_circle_id
          AND cm.user_id = public.app_current_actor_id()
          AND cm.role = 'lead'
          AND cm.status = 'active'
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION app_actor_leads_circle(varchar) OWNER TO unlisted_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_actor_leads_circle(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_actor_leads_circle(varchar) TO unlisted_app, unlisted_admin;
--> statement-breakpoint

-- The one cross-row consistency guarantee C1 pushes into the schema: at most
-- one active lead per circle. docs/state.md A2 known gap flagged the
-- lead_user_id <-> circle_member(role='lead', status='active') invariant as
-- domain-only because it is cross-row; this index covers the half that can be
-- made declarative. The "exactly one, and it is the same person as
-- circle.lead_user_id" half stays in db/circles.ts, which is the only writer
-- and holds a row lock on the circle. Transfer-lead performs the role swap in
-- a single `UPDATE ... SET role = CASE ...` statement so this index never sees
-- a two-lead intermediate (a unique index is checked per statement, not
-- deferred).
CREATE UNIQUE INDEX circle_one_active_lead ON public.circle_member (circle_id)
  WHERE role = 'lead' AND status = 'active';
--> statement-breakpoint

-- circle: SELECT is members-only, so a non-member cannot distinguish "circle
-- exists but I am not in it" from "no such circle" — the row is invisible, and
-- the route returns 404 (agent-rules section 3). unlisted_admin gets nothing
-- on `circle`: no pre-authentication path needs it (unlike `session` in 0007),
-- so it is not added to the admin read surface.
CREATE POLICY circle_app_read ON public.circle FOR SELECT TO unlisted_app
  USING (app_actor_present() AND app_actor_hosts_circle(id));
--> statement-breakpoint

-- circle INSERT: `POST /circles`. This is the one place authorization is off
-- `lead_user_id` rather than a circle_member row — at creation no member row
-- exists yet. The route writes the circle row and the creator's
-- (creator, 'lead', 'active') member row in one transaction.
CREATE POLICY circle_app_insert ON public.circle FOR INSERT TO unlisted_app
  WITH CHECK (app_actor_present() AND lead_user_id = app_current_actor_id());
--> statement-breakpoint

-- circle UPDATE: only ever moves `lead_user_id` (the column grant below scopes
-- it to that one column). USING gates on the *current* lead via
-- app_actor_leads_circle; WITH CHECK additionally requires the incoming
-- lead_user_id to name an active member, so the denormalized column can never
-- point outside the membership even if db/circles.ts has a bug.
CREATE POLICY circle_app_update ON public.circle FOR UPDATE TO unlisted_app
  USING (app_actor_present() AND app_actor_leads_circle(id))
  WITH CHECK (
    app_actor_present()
    AND EXISTS (
      SELECT 1 FROM public.circle_member incoming_lead
      WHERE incoming_lead.circle_id = circle.id
        AND incoming_lead.user_id = circle.lead_user_id
        AND incoming_lead.status = 'active'
    )
  );
--> statement-breakpoint

-- circle_member SELECT, additive to 0004's `circle_member_app_read`. That
-- policy gates on `app_circle_visible(circle_id)`, which is all-or-nothing:
-- if any one active member is blocked by / hidden from the actor, the whole
-- roster disappears — so blocking a co-member would cost you sight of your
-- own circle (and your own membership row). This policy restores the
-- per-member view for an active member of the circle: the roster minus
-- exactly the co-members in a block / enforcement relationship with the
-- actor (`app_user_visible` is the same per-row check 0004's policy already
-- applies alongside `app_circle_visible`). Non-members gain nothing —
-- `app_actor_hosts_circle` requires active membership. Mirrors
-- db/scope/visibility.ts's `circleMember` spec and `circles.get`'s
-- member-id subquery.
CREATE POLICY circle_member_app_roster_read ON public.circle_member FOR SELECT TO unlisted_app
  USING (
    app_actor_present()
    AND app_actor_hosts_circle(circle_member.circle_id)
    AND app_user_visible(circle_member.user_id)
  );
--> statement-breakpoint

-- circle_member INSERT: two legitimate shapes, nothing else.
--   1. a sitting lead invites someone: (user, 'member', 'invited').
--   2. circle creation: the actor writes their own (actor, 'lead', 'active')
--      row into a circle that has no non-removed members yet. The
--      `NOT EXISTS` fence makes this branch satisfiable only during creation:
--      a fully-created circle always has at least one active member, and a
--      circle cannot be emptied (the lead cannot remove themselves — 0009's
--      route layer returns 409 — and the last lead cannot be removed). The
--      transient zero-member window exists only inside the creator's own
--      transaction and is invisible to any other actor (MVCC + this table's
--      SELECT policy). This branch deliberately does not read `circle`:
--      `circle_app_read` is members-only, so the just-inserted circle row is
--      not yet visible to the app role here — `user_id = app_current_actor_id()`
--      plus the fence is what ties the row to the creator.
CREATE POLICY circle_member_app_insert ON public.circle_member FOR INSERT TO unlisted_app
  WITH CHECK (
    app_actor_present()
    AND (
      (app_actor_leads_circle(circle_member.circle_id) AND role = 'member' AND status = 'invited')
      OR (
        role = 'lead' AND status = 'active'
        AND user_id = app_current_actor_id()
        AND NOT EXISTS (
          SELECT 1 FROM public.circle_member existing_member
          WHERE existing_member.circle_id = circle_member.circle_id
            AND existing_member.status <> 'removed'
        )
      )
    )
  );
--> statement-breakpoint

-- circle_member UPDATE: self-service (accept own invitation: invited -> active;
-- remove self: -> removed) or a lead acting on the circle (remove another
-- member; swap the two role rows during transfer-lead). The role swap runs as
-- one statement while the actor is still the lead in the statement snapshot,
-- so app_actor_leads_circle holds for both touched rows. The column grant
-- below scopes this to role / status / joined_at / removed_at.
CREATE POLICY circle_member_app_update ON public.circle_member FOR UPDATE TO unlisted_app
  USING (
    app_actor_present()
    AND (
      circle_member.user_id = app_current_actor_id()
      OR app_actor_leads_circle(circle_member.circle_id)
    )
  )
  WITH CHECK (
    app_actor_present()
    AND (
      circle_member.user_id = app_current_actor_id()
      OR app_actor_leads_circle(circle_member.circle_id)
    )
  );
--> statement-breakpoint

GRANT SELECT, INSERT ON public.circle TO unlisted_app;
--> statement-breakpoint
GRANT UPDATE (lead_user_id) ON public.circle TO unlisted_app;
--> statement-breakpoint
GRANT INSERT ON public.circle_member TO unlisted_app;
--> statement-breakpoint
GRANT UPDATE (role, status, joined_at, removed_at) ON public.circle_member TO unlisted_app;
