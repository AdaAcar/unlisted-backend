import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '../../db/migrations');

/** Strip `-- ...` line comments so assertions match SQL, not prose about SQL. */
function stripComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

const sql = stripComments(readFileSync(resolve(migrations, '0013_application_write.sql'), 'utf8'));

describe('application write migration boundaries (C5 + C6 + C7a)', () => {
  it('is recorded at journal index 13 and leaves the frozen migrations alone', () => {
    const journal = JSON.parse(readFileSync(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.find((e) => e.idx === 13)?.tag).toBe('0013_application_write');
    for (const idx of [0, 1, 4, 11, 12]) {
      expect(journal.entries.find((e) => e.idx === idx)?.tag).toBeTruthy();
    }
  });

  it('opens application / application_member writes with column-scoped UPDATEs', () => {
    expect(sql).toMatch(/GRANT INSERT ON (?:public\.)?application TO unlisted_app/i);
    expect(sql).toMatch(
      /GRANT UPDATE \(\s*state, note, response_deadline, submitted_at, decided_at, withdrawn_at\s*\)\s*ON (?:public\.)?application TO unlisted_app/i,
    );
    expect(sql).toMatch(/GRANT INSERT, DELETE ON (?:public\.)?application_member TO unlisted_app/i);
    expect(sql).toMatch(
      /GRANT UPDATE \(\s*confirmation_state, confirmed_version_hash, invitation_state, hold_expires_at\s*\)\s*ON (?:public\.)?application_member TO unlisted_app/i,
    );
    // No bare table-wide UPDATE on either table.
    expect(sql).not.toMatch(/GRANT UPDATE ON (?:public\.)?application(?:_member)? TO/i);
  });

  it('grants ONLY the two guest-capacity counters on plan, column-scoped, and nothing else', () => {
    expect(sql).toMatch(
      /GRANT UPDATE \(\s*accepted_guest_count, held_count\s*\)\s*ON (?:public\.)?plan TO unlisted_app/i,
    );
    expect(sql).not.toMatch(/GRANT UPDATE ON (?:public\.)?plan/i);
    expect(sql).not.toMatch(/GRANT INSERT[^;]*ON (?:public\.)?plan/i);
    const grant = sql.match(/GRANT UPDATE \(([^)]*)\)\s*ON (?:public\.)?plan/i)?.[1] ?? '';
    expect(grant).not.toMatch(/\bstate\b/);
    expect(grant).not.toMatch(/\bviable_at\b/);
    expect(grant).not.toMatch(/host_circle_id/);
  });

  it('installs the capacity-scope guard trigger that confines a non-host-lead write to the counters', () => {
    expect(sql).toMatch(/CREATE FUNCTION enforce_plan_capacity_scope\(\) RETURNS trigger/i);
    // SECURITY INVOKER (no SECURITY DEFINER on the trigger fn), like enforce_plan_guards.
    expect(sql).not.toMatch(/enforce_plan_capacity_scope[\s\S]*?SECURITY DEFINER[\s\S]*?\$\$/i);
    expect(sql).toMatch(
      /ALTER FUNCTION enforce_plan_capacity_scope\(\) OWNER TO unlisted_migrator/i,
    );
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION enforce_plan_capacity_scope\(\) FROM PUBLIC/i);
    expect(sql).toMatch(
      /CREATE TRIGGER plan_enforce_capacity_scope\s*BEFORE UPDATE ON (?:public\.)?plan/i,
    );
    // It must gate on the lead check and reject changes to lifecycle columns.
    expect(sql).toMatch(/app_actor_leads_circle\(OLD\.host_circle_id\)/i);
    for (const col of ['state', 'venue_id', 'starts_at', 'confirmed_host_count']) {
      expect(sql).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`, 'i'));
    }
  });

  it('adds the two actor-scope predicates, admin-owned SECURITY DEFINER, runtime EXECUTE only', () => {
    for (const fn of ['app_actor_is_application_party', 'app_actor_has_capacity_stake_in_plan']) {
      expect(sql).toMatch(
        new RegExp(`CREATE FUNCTION ${fn}\\(counterparty_\\w+ varchar\\(26\\)\\)`, 'i'),
      );
      expect(sql).toMatch(
        new RegExp(`ALTER FUNCTION ${fn}\\(varchar\\) OWNER TO unlisted_admin`, 'i'),
      );
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${fn}\\(varchar\\) FROM PUBLIC`, 'i'));
      expect(sql).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION ${fn}\\(varchar\\) TO unlisted_app, unlisted_admin`,
          'i',
        ),
      );
    }
  });

  it('adds the overlapping-accepted-plan check as a SECURITY DEFINER predicate', () => {
    expect(sql).toMatch(/CREATE FUNCTION app_user_has_overlapping_accepted_plan\(/i);
    expect(sql).toMatch(/OWNER TO unlisted_admin/i);
    // Half-open interval overlap: other.start < window.end AND window.start < other.end.
    expect(sql).toMatch(/p\.starts_at < COALESCE\(window_end, window_start\)/i);
    expect(sql).toMatch(/COALESCE\(p\.ends_at, p\.starts_at\) > window_start/i);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app_user_has_overlapping_accepted_plan\([^)]*\)\s*TO unlisted_app, unlisted_admin/i,
    );
  });

  it('creates the application write policies plus the plan capacity-update policy', () => {
    expect(sql).toMatch(
      /CREATE POLICY application_app_insert ON (?:public\.)?application FOR INSERT/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY application_app_update ON (?:public\.)?application FOR UPDATE/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY application_member_app_insert ON (?:public\.)?application_member FOR INSERT/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY application_member_app_update ON (?:public\.)?application_member FOR UPDATE/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY application_member_app_delete ON (?:public\.)?application_member FOR DELETE TO unlisted_app\s*USING \(app_actor_present\(\) AND user_id = app_current_actor_id\(\)\)/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY plan_app_capacity_update ON (?:public\.)?plan FOR UPDATE TO unlisted_app\s*USING \(app_actor_present\(\) AND app_actor_has_capacity_stake_in_plan\(id\)\)/i,
    );
  });

  it('gives unlisted_admin no new table access', () => {
    expect(sql).not.toMatch(
      /GRANT[^;]*ON (?:public\.)?(?:application|application_member|plan)[^;]*TO[^;]*unlisted_admin/i,
    );
    expect(sql).not.toMatch(/CREATE POLICY[^;]*TO unlisted_admin/i);
  });
});
