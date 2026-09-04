import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedPublishedPlan, type PlanFixture } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;
let fixture: PlanFixture;

beforeAll(async () => {
  t = await freshDb();
  fixture = await seedPublishedPlan(t);
});

afterAll(async () => {
  await t?.close();
});

describe('pre-ledger migration guard', () => {
  it('fails closed when any viable plan predates ledger installation', async () => {
    await t.pool.query(
      `UPDATE plan SET confirmed_host_count = 3, viable_at = now() WHERE id = $1`,
      [fixture.planId],
    );
    const source = readFileSync(
      resolve(__dirname, '../../db/migrations/0004_a3_corrections.sql'),
      'utf8',
    );
    const guard = source.split('--> statement-breakpoint')[0];
    if (!guard) throw new Error('0004 is missing its fail-closed first statement');
    await expect(t.pool.query(guard)).rejects.toThrow(/pre-ledger viable plan/);
  });
});
