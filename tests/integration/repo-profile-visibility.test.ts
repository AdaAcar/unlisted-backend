import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { users } from '@/db/repositories';

import { seedPublishedPlan, type PlanFixture, userActor } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;
let fixture: PlanFixture;
let applicantId: string;
let outsiderId: string;
let applicationId: string;

beforeAll(async () => {
  t = await freshDb();
  fixture = await seedPublishedPlan(t);
  applicantId = ulid();
  outsiderId = ulid();
  applicationId = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state)
     VALUES ($1, 'Applicant', 'verified'), ($2, 'Outsider', 'verified')`,
    [applicantId, outsiderId],
  );
  await t.pool.query(
    `INSERT INTO application (id, plan_id, solo_user_id, mode, state, submitted_at)
     VALUES ($1, $2, $3, 'planned', 'submitted', now())`,
    [applicationId, fixture.planId, applicantId],
  );
});

afterAll(async () => {
  await t?.close();
});

describe('profile shared-plan context', () => {
  it('allows a host to see an applicant before the plan is viable', async () => {
    const profile = await users.getProfile(fixture.host, applicantId);
    expect(profile?.id).toBe(applicantId);
    expect((await users.getProfile(userActor(applicantId), fixture.hostId))?.id).toBe(
      fixture.hostId,
    );

    const planRow = await t.pool.query<{ viable_at: Date | null }>(
      'SELECT viable_at FROM plan WHERE id = $1',
      [fixture.planId],
    );
    expect(planRow.rows[0]?.viable_at).toBeNull();
  });

  it('returns not-found semantics to an actor without shared plan context', async () => {
    expect(await users.getProfile(userActor(outsiderId), applicantId)).toBeUndefined();
  });

  it('keeps context for every application state except withdrawn', async () => {
    await t.pool.query(`UPDATE application SET state = 'rejected' WHERE id = $1`, [applicationId]);
    expect((await users.getProfile(fixture.host, applicantId))?.id).toBe(applicantId);
  });

  it('removes the context when the application is withdrawn', async () => {
    await t.pool.query(
      `UPDATE application SET state = 'withdrawn', withdrawn_at = now() WHERE id = $1`,
      [applicationId],
    );
    expect(await users.getProfile(fixture.host, applicantId)).toBeUndefined();
  });

  it('returns not-found semantics when either party has blocked the other', async () => {
    await t.pool.query(
      `UPDATE application SET state = 'submitted', withdrawn_at = NULL WHERE id = $1`,
      [applicationId],
    );
    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      applicantId,
      fixture.hostId,
    ]);
    expect(await users.getProfile(fixture.host, applicantId)).toBeUndefined();
  });
});
