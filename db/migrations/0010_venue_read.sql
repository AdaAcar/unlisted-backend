-- C2 (todo_agent.md): read access to the venue registry for unlisted_app.
-- Before this migration unlisted_app cannot read `venue` at all —
-- 0002_rls.sql's `venue_actor_scope` was dropped by 0004_a3_corrections.sql
-- and 0004's six-table replacement grant (user, block, circle_member, plan,
-- application, application_member) omits venue. Everything here is additive.
--
-- Venues are a public registry, not a social object: any authenticated actor
-- sees the same rows, so the policy gates on `app_actor_present()` only — no
-- block / enforcement predicate, because a venue has no counterparty user.
-- There is deliberately no address-protection layer (docs/data-model.md:73).
--
-- C2 is read-only: docs/api.md has no POST /venues; venues arrive via seed
-- data (F3). No INSERT/UPDATE/DELETE grant, and no policy for those verbs.
CREATE POLICY venue_app_read ON public.venue FOR SELECT TO unlisted_app
  USING (app_actor_present());
--> statement-breakpoint

-- Column-scoped SELECT on exactly the six public columns
-- (docs/data-model.md Venue). `licence_ref` and `capacity_hint` are
-- `internal` and are omitted here, so "never serialized" is a database
-- guarantee rather than a view-model omission to remember — the same
-- column-scoping pattern 0008_verification.sql used for "user". A
-- table-wide `GRANT SELECT` would make the view model the only line of
-- defence; this keeps it a second one.
--
-- Column-level REVOKE cannot subtract from a table-level grant in Postgres,
-- but no table-wide grant on venue exists for either runtime role (0004
-- revoked everything), so an explicit column GRANT is all that is needed.
GRANT SELECT (id, name, address, district, type, operator_verified)
  ON public.venue TO unlisted_app;
