import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '../../db/migrations');

/** Strip `-- ...` line comments so assertions match SQL, not prose about SQL. */
function stripComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

const sql = stripComments(readFileSync(resolve(migrations, '0011_plan_write.sql'), 'utf8'));

describe('plan write migration boundaries (C3)', () => {
  it('is recorded at journal index 11 and leaves the frozen migrations alone', () => {
    const journal = JSON.parse(readFileSync(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.find((e) => e.idx === 11)?.tag).toBe('0011_plan_write');
    for (const idx of [0, 1, 4, 9, 10]) {
      expect(journal.entries.find((e) => e.idx === idx)?.tag).toBeTruthy();
    }
  });

  it('grants unlisted_app INSERT plus a column-scoped UPDATE on plan, and nothing table-wide', () => {
    expect(sql).toMatch(/GRANT INSERT ON (?:public\.)?plan TO unlisted_app/i);
    expect(sql).toMatch(/GRANT UPDATE \(\s*[^)]*\)\s*ON (?:public\.)?plan TO unlisted_app/i);
    // A bare, un-parenthesised UPDATE grant would be table-wide — must not exist.
    expect(sql).not.toMatch(/GRANT UPDATE ON (?:public\.)?plan/i);
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*ON[^;]*plan/i);
  });

  it('keeps host_circle_id and the guest capacity counters out of the UPDATE column list', () => {
    const grant = sql.match(/GRANT UPDATE \(([^)]*)\)\s*ON (?:public\.)?plan/i)?.[1] ?? '';
    expect(grant).toMatch(/\bstate\b/);
    expect(grant).toMatch(/\bmode\b/);
    expect(grant).toMatch(/\bviable_at\b/);
    expect(grant).toMatch(/\bconfirmed_host_count\b/);
    expect(grant).not.toMatch(/host_circle_id/);
    expect(grant).not.toMatch(/accepted_guest_count/);
    expect(grant).not.toMatch(/held_count/);
    expect(grant).not.toMatch(/confirmed_total/);
  });

  it('gates both write policies on the lead check, never on plan.lead_user_id-style denormalisation', () => {
    expect(sql).toMatch(
      /CREATE POLICY plan_app_insert ON (?:public\.)?plan FOR INSERT TO unlisted_app\s*WITH CHECK \(app_actor_present\(\) AND app_actor_leads_circle\(host_circle_id\)\)/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY plan_app_update ON (?:public\.)?plan FOR UPDATE TO unlisted_app\s*USING \(app_actor_present\(\) AND app_actor_leads_circle\(host_circle_id\)\)/i,
    );
  });

  it('adds a SECURITY DEFINER active-host-member counter, executable by the runtime roles only', () => {
    expect(sql).toMatch(
      /CREATE FUNCTION app_active_host_member_count\(counterparty_circle_id varchar\(26\)\) RETURNS integer/i,
    );
    expect(sql).toMatch(
      /LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public/i,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION app_active_host_member_count\(varchar\) FROM PUBLIC/i,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app_active_host_member_count\(varchar\) TO unlisted_app, unlisted_admin/i,
    );
  });

  it('touches only plan (plus the shared counter fn); gives unlisted_admin no new plan access', () => {
    expect(sql).not.toMatch(
      /\bON (?:public\.)?"?(?:user|venue|session|audit_log|application|message_thread|circle)"?\b/i,
    );
    // The only unlisted_admin mentions are the counter function's OWNER/EXECUTE
    // (same shape as 0009's app_actor_leads_circle) — nothing on the plan table.
    expect(sql).not.toMatch(/POLICY[^;]*plan[^;]*unlisted_admin/i);
    expect(sql).not.toMatch(/GRANT[^;]*ON (?:public\.)?plan TO[^;]*unlisted_admin/i);
  });
});
