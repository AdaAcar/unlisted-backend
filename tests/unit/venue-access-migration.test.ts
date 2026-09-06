import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '../../db/migrations');

/** Strip `-- ...` line comments so assertions match SQL, not prose about SQL. */
function stripComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

const sql = stripComments(readFileSync(resolve(migrations, '0010_venue_read.sql'), 'utf8'));

describe('venue access migration boundaries (C2)', () => {
  it('is recorded at journal index 10 and leaves the frozen migrations alone', () => {
    const journal = JSON.parse(readFileSync(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.find((e) => e.idx === 10)?.tag).toBe('0010_venue_read');
    for (const idx of [0, 4, 8, 9]) {
      expect(journal.entries.find((e) => e.idx === idx)?.tag).toBeTruthy();
    }
  });

  it('grants unlisted_app a column-scoped SELECT on exactly the six public columns', () => {
    expect(sql).toMatch(
      /GRANT SELECT \(id, name, address, district, type, operator_verified\)\s*ON (?:public\.)?venue TO unlisted_app/i,
    );
    expect(sql).not.toMatch(/licence_ref/i);
    expect(sql).not.toMatch(/capacity_hint/i);
  });

  it('is read-only: no write grant, no write policy, nothing for unlisted_admin', () => {
    expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON[^;]*venue/i);
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE|DELETE)/i);
    expect(sql).not.toMatch(/unlisted_admin/i);
  });

  it('gates the read policy on presence only — no block / enforcement predicate', () => {
    expect(sql).toMatch(
      /CREATE POLICY venue_app_read ON (?:public\.)?venue FOR SELECT TO unlisted_app\s*USING \(app_actor_present\(\)\)/i,
    );
    expect(sql).not.toMatch(/block|enforcement|app_user_visible/i);
  });

  it('only touches venue', () => {
    expect(sql).not.toMatch(
      /\bON (?:public\.)?"?(?:user|plan|application|session|audit_log|circle)"?\b/i,
    );
  });
});
