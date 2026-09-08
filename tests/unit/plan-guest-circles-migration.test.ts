import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '../../db/migrations');

/** Strip `-- ...` line comments so assertions match SQL, not prose about SQL. */
function stripComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

const sql = stripComments(readFileSync(resolve(migrations, '0015_plan_guest_circles.sql'), 'utf8'));

describe('plan guest-circles migration boundaries (C7c fix)', () => {
  it('is recorded at journal index 15 and leaves the frozen migrations alone', () => {
    const journal = JSON.parse(readFileSync(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.find((e) => e.idx === 15)?.tag).toBe('0015_plan_guest_circles');
    for (const idx of [0, 1, 4, 11, 12, 13, 14]) {
      expect(journal.entries.find((e) => e.idx === idx)?.tag).toBeTruthy();
    }
  });

  it('adds a SECURITY DEFINER guest-circle read, SETOF, with a pinned search_path', () => {
    expect(sql).toMatch(
      /CREATE FUNCTION app_plan_guest_circle_ids\(target_plan_id varchar\(26\)\)\s*RETURNS SETOF varchar\(26\)/i,
    );
    expect(sql).toMatch(
      /LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public/i,
    );
  });

  it('is owned by unlisted_admin, executable by unlisted_app only, and not by PUBLIC', () => {
    expect(sql).toMatch(
      /ALTER FUNCTION app_plan_guest_circle_ids\(varchar\) OWNER TO unlisted_admin/i,
    );
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION app_plan_guest_circle_ids\(varchar\) FROM PUBLIC/i);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app_plan_guest_circle_ids\(varchar\) TO unlisted_app\b/i,
    );
    // No explicit grant to unlisted_admin (it holds EXECUTE via ownership), and
    // nothing wider.
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION app_plan_guest_circle_ids\(varchar\) TO[^;]*PUBLIC/i,
    );
  });

  it('reads only `application`, filtered to live accepted / approved circle rows', () => {
    expect(sql).toMatch(/FROM public\.application a/i);
    expect(sql).toMatch(/a\.applicant_circle_id IS NOT NULL/i);
    expect(sql).toMatch(/a\.mode = 'planned'\s*AND a\.state = 'accepted'/i);
    expect(sql).toMatch(/a\.mode = 'tonight'\s*AND a\.state = 'approved'/i);
  });

  it('creates no table, no policy, and no RLS change (a pure helper migration)', () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/\bGRANT (SELECT|INSERT|UPDATE|DELETE)\b/i);
  });
});
