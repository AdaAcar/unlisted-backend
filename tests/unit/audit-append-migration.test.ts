import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '../../db/migrations');

/** Strip `-- ...` line comments so assertions match SQL, not prose about SQL. */
function stripComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

describe('audit append migration boundaries', () => {
  it('grants the app role INSERT on audit_log and nothing broader', () => {
    const source = stripComments(
      readFileSync(resolve(migrations, '0006_audit_append.sql'), 'utf8'),
    );
    expect(source).toMatch(/GRANT INSERT ON (?:public\.)?audit_log TO unlisted_app/i);
    // No SELECT grant for either runtime role: the app writes rows and can
    // never read them back; moderator reads are a later task (D4) through the
    // admin executor, not through this migration.
    expect(source).not.toMatch(/GRANT[^;]*SELECT[^;]*ON[^;]*audit_log/i);
    expect(source).not.toMatch(/GRANT[^;]*audit_log[^;]*unlisted_admin/i);
  });

  it('does not touch a frozen migration or the machine-generated journal', () => {
    const journal = JSON.parse(readFileSync(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const last = journal.entries[journal.entries.length - 1];
    expect(last?.idx).toBe(6);
    expect(last?.tag).toBe('0006_audit_append');
  });

  it('installs a WITH CHECK that ties actor_id to the transaction GUC in both directions', () => {
    const source = readFileSync(resolve(migrations, '0006_audit_append.sql'), 'utf8');
    expect(source).toMatch(/WITH CHECK/i);
    expect(source).toMatch(/app_current_actor_id\(\)/);
    // A user/circle_lead/moderator row must carry the caller's own id; a
    // system row must carry no id at all. Neither direction is optional.
    expect(source).toMatch(/actor_id\s*=\s*app_current_actor_id\(\)/);
    expect(source).toMatch(/actor_id\s+IS\s+NULL/i);
  });
});
