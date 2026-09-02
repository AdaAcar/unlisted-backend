import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { plans } from '@/db/repositories';

import { seedPublishedPlan, type PlanFixture, userActor } from './support/a3';
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

describe('silent enforcement visibility', () => {
  for (const standing of ['restricted', 'suspended', 'banned'] as const) {
    it(`hides a ${standing} host from other actors but not from self`, async () => {
      await t.pool.query(`UPDATE "user" SET standing = $1 WHERE id = $2`, [
        standing,
        fixture.hostId,
      ]);

      expect(await plans.feed(fixture.actor, { district: 'Kadikoy' })).toEqual([]);
      const selfRows = await plans.feed(userActor(fixture.hostId, standing), {
        district: 'Kadikoy',
      });
      expect(selfRows.map((row) => row.id)).toContain(fixture.planId);
    });
  }
});
