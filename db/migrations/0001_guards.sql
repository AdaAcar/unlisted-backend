-- 0001_guards.sql
--
-- Hand-written guarantees that drizzle-kit cannot express from the schema:
-- a cross-table foreign key to a generated column, trigger functions, triggers,
-- and column comments.
--
-- The MIN_PLAN_TOTAL literal (3) appears in this file exactly TWICE, each marked
--   /* MIN_PLAN_TOTAL: keep equal to lib/config.ts */
-- tests/unit/migration-min-plan-total.test.ts asserts both occurrences equal
-- config.MIN_PLAN_TOTAL. SQL cannot import the TypeScript constant, so this
-- annotation is the single checkable link.

--------------------------------------------------------------------------------
-- updated_at maintenance (DB-owned, not ORM-owned)
--------------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER user_set_updated_at BEFORE UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER record_set_updated_at BEFORE UPDATE ON "record"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER circle_set_updated_at BEFORE UPDATE ON "circle"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER circle_member_set_updated_at BEFORE UPDATE ON "circle_member"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER venue_set_updated_at BEFORE UPDATE ON "venue"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER plan_set_updated_at BEFORE UPDATE ON "plan"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER application_set_updated_at BEFORE UPDATE ON "application"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER application_member_set_updated_at BEFORE UPDATE ON "application_member"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER message_thread_set_updated_at BEFORE UPDATE ON "message_thread"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER message_set_updated_at BEFORE UPDATE ON "message"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER signal_set_updated_at BEFORE UPDATE ON "signal"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

--------------------------------------------------------------------------------
-- plan: mode immutability + viable_at latch + viable_at set-time floor
--------------------------------------------------------------------------------
CREATE FUNCTION enforce_plan_guards() RETURNS trigger AS $$
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
  -- while viable_at stays set — that case is allowed.)
  IF NEW.viable_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.viable_at IS NULL)
     AND (NEW.confirmed_host_count + NEW.accepted_guest_count)
         < 3 /* MIN_PLAN_TOTAL: keep equal to lib/config.ts */ THEN
    RAISE EXCEPTION 'plan.viable_at set below MIN_PLAN_TOTAL (plan %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER plan_enforce_guards BEFORE INSERT OR UPDATE ON "plan"
  FOR EACH ROW EXECUTE FUNCTION enforce_plan_guards();
--> statement-breakpoint

--------------------------------------------------------------------------------
-- message_thread: participant floor
--------------------------------------------------------------------------------
ALTER TABLE "message_thread"
  ADD CONSTRAINT "message_thread_min_participants_chk"
  CHECK (participant_count >= 3 /* MIN_PLAN_TOTAL: keep equal to lib/config.ts */);
--> statement-breakpoint

--------------------------------------------------------------------------------
-- "No thread on a non-viable plan", structurally
--
-- viable_plan_key equals the plan id only while viable_at IS NOT NULL. It is
-- monotonic because enforce_plan_guards() forbids clearing viable_at. A thread
-- row can only reference a plan whose key is populated, i.e. one that has
-- reached viability. This cannot be forgotten the way a trigger check could.
--------------------------------------------------------------------------------
ALTER TABLE "plan"
  ADD COLUMN "viable_plan_key" varchar(26)
  GENERATED ALWAYS AS (CASE WHEN viable_at IS NOT NULL THEN id END) STORED;
--> statement-breakpoint
ALTER TABLE "plan"
  ADD CONSTRAINT "plan_viable_plan_key_uq" UNIQUE ("viable_plan_key");
--> statement-breakpoint
ALTER TABLE "message_thread"
  ADD CONSTRAINT "message_thread_plan_viable_fk"
  FOREIGN KEY ("plan_id") REFERENCES "plan" ("viable_plan_key");
--> statement-breakpoint

--------------------------------------------------------------------------------
-- audit_log: append-only
--
-- Enforced by trigger here. GRANT/REVOKE for the application role is deferred to
-- A3 (no such role exists yet) — tracked in docs/state.md section 11.
--------------------------------------------------------------------------------
CREATE FUNCTION reject_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
--> statement-breakpoint

--------------------------------------------------------------------------------
-- restricted-column annotations (encryption at rest is applied in B2)
--------------------------------------------------------------------------------
COMMENT ON COLUMN "user"."identity_hash" IS 'restricted: encrypt at rest, separate key and access control (B2). Exists for ban durability; must not be reversible to the document.';
--> statement-breakpoint
COMMENT ON COLUMN "user"."verification_ref" IS 'restricted: encrypt at rest, separate key and access control (B2). Vendor reference only; the document is never stored.';
