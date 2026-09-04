-- A4: narrow, deliberate restoration of an append-only write path on
-- audit_log. 0004_a3_corrections.sql revoked every privilege the runtime
-- roles held (least-privilege correction, not reversed here) and dropped the
-- INSERT policy 0002_rls.sql had created. This migration grants unlisted_app
-- INSERT on audit_log only — no SELECT, no UPDATE, no DELETE, and nothing at
-- all for unlisted_admin. The app writes audit rows and can never read them
-- back; moderator reads are a later task (D4), through the admin executor.
--
-- The WITH CHECK below is stricter than the policy 0004 dropped: it ties
-- actor_role to actor_id in both directions, not just one. A user/circle_lead
-- action must carry the caller's own id (never someone else's, and never
-- null); a system action must carry no id at all and a system-shaped GUC.
-- Without the second half, a user's own transaction could label its action
-- 'system' while keeping its own id — the id would still be honest, but the
-- role would be a lie the row-level check should not let through. There is no
-- moderator GUC yet (moderator capability is not an actor field until D4;
-- see docs/state.md A3 decisions), so this cannot pin actor_role = 'moderator'
-- to a distinct credential; audit_log_moderator_reason_chk (0001_guards.sql)
-- is the only guard on that role today, which is why a moderator entry with
-- no reason must fail regardless of who is calling.
GRANT INSERT ON public.audit_log TO unlisted_app;
--> statement-breakpoint

-- Explicit and redundant with 0004's blanket REVOKE ALL — stated here so a
-- future reader of this file cannot mistake the grant above for anything
-- broader than INSERT.
REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON public.audit_log FROM unlisted_app, unlisted_admin;
--> statement-breakpoint

CREATE POLICY audit_log_app_append ON public.audit_log FOR INSERT TO unlisted_app
  WITH CHECK (
    app_actor_present()
    AND (
      (actor_role = 'system' AND actor_id IS NULL AND app_current_actor_id() LIKE 'system:%')
      OR (actor_role <> 'system' AND actor_id = app_current_actor_id())
    )
  );
