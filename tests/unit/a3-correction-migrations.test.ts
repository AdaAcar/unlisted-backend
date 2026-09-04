import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '../../db/migrations');

describe('A3 correction migration boundaries', () => {
  it('fails closed before installing custom behavior when viable plans predate the ledger', () => {
    const source = readFileSync(resolve(migrations, '0004_a3_corrections.sql'), 'utf8');
    const guard = source.indexOf('pre-ledger viable plan');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(source.indexOf('CREATE FUNCTION'));
  });

  it('keeps population functions trigger-only and credentials out of migrations', () => {
    const source = readFileSync(resolve(migrations, '0004_a3_corrections.sql'), 'utf8');
    expect(source).not.toMatch(/GRANT EXECUTE ON FUNCTION append_[^(]+\([^)]*\) TO unlisted_app/i);
    expect(source).toMatch(/ALTER ROLE unlisted_app[\s\S]*NOLOGIN[\s\S]*PASSWORD NULL/i);
    expect(source).toMatch(/ALTER ROLE unlisted_admin[\s\S]*NOLOGIN[\s\S]*NOBYPASSRLS/i);
    expect(source).not.toMatch(/PASSWORD\s+'[^']+'/i);
  });
});
