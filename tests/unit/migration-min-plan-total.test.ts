import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { config } from '@/lib/config';

const MIGRATIONS = resolve(__dirname, '../../db/migrations');
const init = readFileSync(resolve(MIGRATIONS, '0000_init.sql'), 'utf8');

const ANNOTATED = /(\d+)\s*\/\* MIN_PLAN_TOTAL: keep equal to lib\/config\.ts \*\//g;

/**
 * The MIN_PLAN_TOTAL literal appears in SQL only where it is annotated, and
 * every annotated occurrence equals `config.MIN_PLAN_TOTAL`. SQL cannot import
 * the TypeScript constant — the annotation is the single checkable link.
 *
 * It now lives in two migration files: `0001_guards.sql` (the original set-time
 * floor + the `message_thread_min_participants_chk`) and `0014_tighten_viability.sql`
 * (the CREATE OR REPLACE of `enforce_plan_guards()` that carries the set-time
 * floor forward with Decision B's extra disjunct). So the count is per-file, not
 * one global total.
 */
const EXPECTED_PER_FILE: Record<string, number> = {
  '0001_guards.sql': 2,
  '0014_tighten_viability.sql': 1,
};

describe('MIN_PLAN_TOTAL literal in the migrations', () => {
  it('is annotated wherever it appears, per-file, and every occurrence equals config.MIN_PLAN_TOTAL', () => {
    const sqlFiles = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));
    const perFile: Record<string, number> = {};

    for (const name of sqlFiles) {
      const body = readFileSync(resolve(MIGRATIONS, name), 'utf8');
      const values = [...body.matchAll(ANNOTATED)].map((m) => Number(m[1]));
      if (values.length > 0) perFile[name] = values.length;
      for (const value of values) {
        expect(value, name).toBe(config.MIN_PLAN_TOTAL);
      }
    }

    expect(perFile).toEqual(EXPECTED_PER_FILE);
  });

  it('is not hardcoded unannotated in the viability / participant guards', () => {
    // The drizzle-generated 0000 must not carry these.
    expect(init).not.toMatch(/participant_count\s*>=\s*\d/);
    expect(init).not.toMatch(/confirmed_host_count\s*\+\s*accepted_guest_count\s*\)?\s*>=\s*\d/);

    // The files that actually carry the guard SQL (0001, and 0014's CREATE OR
    // REPLACE) must not contain a bare `CHECK (participant_count >= 3` without
    // the annotation. Other migrations' prose may mention the number freely.
    const bareParticipant = /CHECK\s*\(\s*participant_count\s*>=\s*3(?!\s*\/\* MIN_PLAN_TOTAL)/;
    for (const name of ['0001_guards.sql', '0014_tighten_viability.sql']) {
      expect(readFileSync(resolve(MIGRATIONS, name), 'utf8'), name).not.toMatch(bareParticipant);
    }
  });
});
