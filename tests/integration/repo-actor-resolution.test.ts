import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';

import { loadActorByUserId } from '@/db/scope/resolve';

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

describe('actor resolution seam', () => {
  it('loads only the actor fields required by repositories', async () => {
    await expect(loadActorByUserId(fixture.actorId)).resolves.toEqual(fixture.actor);
  });

  it('fails closed for an unknown user id', async () => {
    await expect(loadActorByUserId(ulid())).rejects.toThrow(/does not exist/);
  });
});
