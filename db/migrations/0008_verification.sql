CREATE UNIQUE INDEX "user_verification_ref_uq" ON "user" USING btree ("verification_ref");
--> statement-breakpoint

-- B2: encryption-at-rest gap closed for identity_hash/verification_ref
-- (0001_guards.sql's COMMENT annotations, docs/state.md A2 known gap) via a
-- keyed hash (identity_hash is never the raw identity — see
-- lib/identityHash.ts) plus column-level access control, not pgcrypto: no
-- KMS/hosting target exists yet (docs/state.md External/undecided), and a
-- non-reversible hash combined with denying SELECT on both columns
-- satisfies the practical intent at far lower key-management cost.
--
-- 0004_a3_corrections.sql's blanket `GRANT SELECT ON public."user", ...`
-- covers every column, identity_hash and verification_ref included. This
-- supersedes that grant for this one table only (same pattern as 0006
-- superseding 0004 for audit_log) with an explicit column list that omits
-- both restricted columns. Column-level REVOKE cannot subtract from a
-- table-level grant in Postgres, so the only way to actually deny SELECT on
-- specific columns is to revoke the table-wide grant and re-grant an
-- explicit column list.
REVOKE SELECT ON public."user" FROM unlisted_app, unlisted_admin;
--> statement-breakpoint
GRANT SELECT (
  id, first_name, photos, bio, age, district, verification_state,
  standing, signal_score, created_at, updated_at, deleted_at
) ON public."user" TO unlisted_app, unlisted_admin;
--> statement-breakpoint

-- unlisted_app alone gets SELECT on verification_ref: Postgres requires
-- SELECT privilege on any column a query's WHERE clause filters on (same
-- reasoning as 0007_session.sql's session SELECT grant), and
-- db/verification.ts's webhook write matches its target row by
-- `WHERE verification_ref = ...`. unlisted_admin has no path that needs it
-- and does not get it. Neither role ever gets SELECT on identity_hash --
-- nothing in this codebase reads it back; the UNIQUE index
-- (user_identity_hash_uq, 0000_init.sql) enforces the ban-durability
-- collision entirely inside Postgres.
GRANT SELECT (verification_ref) ON public."user" TO unlisted_app;
--> statement-breakpoint

-- The webhook is vendor-authenticated: there is no session and no user
-- actor (todo_agent.md B2), so its write runs as a SystemActor through
-- withActor (db/scope/scoped.ts), the same mechanism A4's audit rows use.
-- This grant is narrow and column-scoped: unlisted_app may UPDATE exactly
-- these four columns, nothing else on "user" gains UPDATE.
GRANT UPDATE (verification_state, age, identity_hash, verification_ref)
  ON public."user" TO unlisted_app;
--> statement-breakpoint

-- A column grant alone gives no row visibility for UPDATE: 0004_a3_corrections.sql
-- dropped the original 0002_rls.sql `user_actor_scope` (FOR ALL) policy and
-- replaced it with `user_app_read`, a SELECT-only policy -- there is no
-- other UPDATE policy on "user" for unlisted_app to lean on or collide
-- with. This policy is the only thing that lets the grant above actually
-- match a row, and it is system-actor-scoped on both sides (USING for the
-- pre-image, WITH CHECK for the post-image), so a real user-actor
-- transaction (a session request, not a SystemActor) can never satisfy it
-- regardless of what it is granted.
CREATE POLICY user_system_verification_write ON public."user" FOR UPDATE TO unlisted_app
  USING (app_current_actor_id() LIKE 'system:%')
  WITH CHECK (app_current_actor_id() LIKE 'system:%');
--> statement-breakpoint

-- Belt-and-suspenders beyond the policy above: a BEFORE UPDATE trigger,
-- mirroring audit_log's append-only guard (0001_guards.sql's
-- reject_audit_log_mutation), that rejects any change to these four
-- columns specifically unless the actor is system-labeled. The policy above
-- already restricts the whole row to system-actor UPDATEs; this additionally
-- protects the four columns even if some future migration adds a broader
-- UPDATE policy back onto "user" for other (non-verification) columns --
-- RLS policies combine permissively (OR), so a future broader policy could
-- otherwise silently widen access to these columns too. The trigger holds
-- regardless of how many policies exist.
CREATE FUNCTION enforce_verification_columns_system_only() RETURNS trigger AS $$
BEGIN
  IF (
    NEW.verification_state IS DISTINCT FROM OLD.verification_state
    OR NEW.age IS DISTINCT FROM OLD.age
    OR NEW.identity_hash IS DISTINCT FROM OLD.identity_hash
    OR NEW.verification_ref IS DISTINCT FROM OLD.verification_ref
  ) AND NOT (COALESCE(current_setting('app.actor_id', true), '') LIKE 'system:%') THEN
    RAISE EXCEPTION 'verification_state, age, identity_hash, and verification_ref can only be changed by a system actor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER user_verification_columns_system_only BEFORE UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION enforce_verification_columns_system_only();