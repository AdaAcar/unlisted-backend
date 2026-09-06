import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '../../db/migrations');

/** Strip `-- ...` line comments so assertions match SQL, not prose about SQL. */
function stripComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

const sql = stripComments(readFileSync(resolve(migrations, '0009_circle_access.sql'), 'utf8'));

describe('circle access migration boundaries (C1)', () => {
  it('is recorded at journal index 9 and leaves the frozen migrations alone', () => {
    const journal = JSON.parse(readFileSync(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.find((e) => e.idx === 9)?.tag).toBe('0009_circle_access');
    for (const idx of [0, 4, 6, 7, 8]) {
      expect(journal.entries.find((e) => e.idx === idx)?.tag).toBeTruthy();
    }
  });

  it('grants the app role only circle read + circle/circle_member write, all column-scoped where it writes', () => {
    expect(sql).toMatch(/GRANT SELECT, INSERT ON (?:public\.)?circle TO unlisted_app/i);
    expect(sql).toMatch(/GRANT UPDATE \(lead_user_id\) ON (?:public\.)?circle TO unlisted_app/i);
    expect(sql).toMatch(/GRANT INSERT ON (?:public\.)?circle_member TO unlisted_app/i);
    expect(sql).toMatch(
      /GRANT UPDATE \(role, status, joined_at, removed_at\) ON (?:public\.)?circle_member TO unlisted_app/i,
    );
    // No blanket UPDATE, no DELETE, nothing for unlisted_admin.
    expect(sql).not.toMatch(/GRANT[^;]*UPDATE ON (?:public\.)?circle\b/i);
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*ON[^;]*circle/i);
    expect(sql).not.toMatch(/GRANT[^;]*ON (?:public\.)?circle(?:_member)?\b[^;]*unlisted_admin/i);
  });

  it('authorizes lead-only writes off circle_member, never circle.lead_user_id', () => {
    expect(sql).toMatch(/CREATE FUNCTION app_actor_leads_circle/);
    expect(sql).toMatch(/role = 'lead'\s+AND\s+status = 'active'/);
    // The only place lead_user_id is read for authorization is circle INSERT
    // (creation carve-out) and the transfer WITH CHECK (new lead must be an
    // active member). The lead-check function does not mention it.
    const fnBody = sql.slice(
      sql.indexOf('CREATE FUNCTION app_actor_leads_circle'),
      sql.indexOf('$$ LANGUAGE sql STABLE SECURITY DEFINER', sql.indexOf('app_actor_leads_circle')),
    );
    expect(fnBody).not.toMatch(/lead_user_id/);
  });

  it('makes at most one active lead per circle a schema guarantee', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX circle_one_active_lead ON (?:public\.)?circle_member \(circle_id\)\s*WHERE role = 'lead' AND status = 'active'/i,
    );
  });

  it('only touches circle and circle_member', () => {
    // No ALTER/CREATE POLICY/GRANT against user, plan, application, session, etc.
    expect(sql).not.toMatch(
      /\bON (?:public\.)?"?(?:user|plan|application|session|audit_log|venue)"?\b/i,
    );
  });
});
