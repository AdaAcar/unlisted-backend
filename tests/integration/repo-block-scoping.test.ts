import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminDb } from '@/db/admin';
import { plans } from '@/db/repositories';
import { plan } from '@/db/schema';

import { requiredTestUrl, seedPublishedPlan, type PlanFixture } from './support/a3';
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

describe('plan repository block scoping', () => {
  it('applies the bidirectional block exclusion in SQL before rows enter memory', async () => {
    const query = plans.feed(fixture.actor, { district: 'Kadikoy' });
    const compiled = query.toSQL().sql.toLowerCase();
    expect(compiled).toContain('not exists');
    expect(compiled).toContain('block');
    const initialRows = await query;
    expect(initialRows.map((row) => row.id)).toContain(fixture.planId);
    expect(initialRows[0]?.startsAt).toBeInstanceOf(Date);
    expect((await plans.get(fixture.actor, fixture.planId))?.id).toBe(fixture.planId);

    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      fixture.actorId,
      fixture.hostId,
    ]);

    expect(await plans.feed(fixture.actor, { district: 'Kadikoy' })).toEqual([]);
    expect(await plans.get(fixture.actor, fixture.planId)).toBeUndefined();
    expect(
      (await plans.feed(fixture.host, { district: 'Kadikoy' })).map((row) => row.id),
    ).toContain(fixture.planId);

    await t.pool.query(`DELETE FROM block WHERE blocker_user_id = $1 AND blocked_user_id = $2`, [
      fixture.actorId,
      fixture.hostId,
    ]);
    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      fixture.hostId,
      fixture.actorId,
    ]);
    expect(await plans.feed(fixture.actor, { district: 'Kadikoy' })).toEqual([]);

    const adminRows = await adminDb().select({ id: plan.id }).from(plan);
    expect(adminRows.map((row) => row.id)).toContain(fixture.planId);
  });

  it('mirrors block filtering in RLS for a raw app-role query', async () => {
    const pool = new Pool({ connectionString: requiredTestUrl('APP_DATABASE_URL') });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [fixture.actorId]);
      await client.query(`SELECT set_config('app.actor_standing', 'good', true)`);
      const result = await client.query<{ id: string }>('SELECT id FROM plan');
      await client.query('COMMIT');
      expect(result.rows).toEqual([]);
    } finally {
      client.release();
      await pool.end();
    }
  });
});
