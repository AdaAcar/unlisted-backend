import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { config } from '@/lib/config';

const MIGRATIONS = resolve(__dirname, '../../db/migrations');
const guards = readFileSync(resolve(MIGRATIONS, '0001_guards.sql'), 'utf8');
const init = readFileSync(resolve(MIGRATIONS, '0000_init.sql'), 'utf8');

const ANNOTATED = /(\d+)\s*\/\* MIN_PLAN_TOTAL: keep equal to lib\/config\.ts \*\//g;

describe('MIN_PLAN_TOTAL literal in the migrations', () => {
  it('appears exactly twice, annotated, and every occurrence equals config.MIN_PLAN_TOTAL', () => {
    const values = [...guards.matchAll(ANNOTATED)].map((m) => Number(m[1]));

    expect(values).toHaveLength(2);
    for (const value of values) {
      expect(value).toBe(config.MIN_PLAN_TOTAL);
    }
  });

  it('is not hardcoded unannotated in the viability / participant guards', () => {
    // The participant floor and the viability set-time floor must only appear in
    // 0001_guards.sql, annotated. The drizzle-generated 0000 must not carry them.
    expect(init).not.toMatch(/participant_count\s*>=\s*\d/);
    expect(init).not.toMatch(/confirmed_host_count\s*\+\s*accepted_guest_count\s*\)?\s*>=\s*\d/);

    // And 0001 must not contain a bare `>= 3` tied to these without the annotation.
    const bareParticipant = /participant_count\s*>=\s*3(?!\s*\/\* MIN_PLAN_TOTAL)/;
    expect(guards).not.toMatch(bareParticipant);
  });
});
