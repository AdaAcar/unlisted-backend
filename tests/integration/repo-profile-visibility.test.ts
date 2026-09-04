import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { users } from '@/db/repositories';

import { seedPublishedPlan, type PlanFixture, userActor } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;
let fixture: PlanFixture;
let applicantId: string;
let secondApplicantId: string;
let outsiderId: string;
let applicationId: string;
let secondApplicationId: string;

beforeAll(async () => {
  t = await freshDb();
  fixture = await seedPublishedPlan(t);
  applicantId = ulid();
  secondApplicantId = ulid();
  outsiderId = ulid();
  applicationId = ulid();
  secondApplicationId = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state)
     VALUES ($1, 'Applicant', 'verified'), ($2, 'Second applicant', 'verified'),
            ($3, 'Outsider', 'verified')`,
    [applicantId, secondApplicantId, outsiderId],
  );
  await t.pool.query(
    `INSERT INTO application (id, plan_id, solo_user_id, mode, state, submitted_at)
     VALUES ($1, $3, $4, 'planned', 'submitted', now()),
            ($2, $3, $5, 'planned', 'submitted', now())`,
    [applicationId, secondApplicationId, fixture.planId, applicantId, secondApplicantId],
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

  it('denies applicant-to-applicant visibility in both directions before viability', async () => {
    expect(await users.getProfile(userActor(applicantId), secondApplicantId)).toBeUndefined();
    expect(await users.getProfile(userActor(secondApplicantId), applicantId)).toBeUndefined();
  });

  it('returns not-found semantics to an actor without shared plan context', async () => {
    expect(await users.getProfile(userActor(outsiderId), applicantId)).toBeUndefined();
  });

  it('keeps host review context for a rejected application', async () => {
    await t.pool.query(`UPDATE application SET state = 'rejected' WHERE id = $1`, [applicationId]);
    expect((await users.getProfile(fixture.host, applicantId))?.id).toBe(applicantId);
  });

  it('makes only ledgered accepted participants mutually visible after viability', async () => {
    await t.pool.query(`UPDATE application SET state = 'accepted' WHERE id IN ($1, $2)`, [
      applicationId,
      secondApplicationId,
    ]);
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = 2, viable_at = now() WHERE id = $1`,
      [fixture.planId],
    );
    expect((await users.getProfile(userActor(applicantId), secondApplicantId))?.id).toBe(
      secondApplicantId,
    );
    expect((await users.getProfile(userActor(secondApplicantId), applicantId))?.id).toBe(
      applicantId,
    );

    for (const state of [
      'submitted',
      'shortlisted',
      'invited',
      'rejected',
      'declined',
      'expired',
      'withdrawn',
    ]) {
      const hiddenId = ulid();
      await t.pool.query(`INSERT INTO "user" (id, first_name) VALUES ($1, $2)`, [
        hiddenId,
        `Hidden ${state}`,
      ]);
      await t.pool.query(
        `INSERT INTO application (id, plan_id, solo_user_id, mode, state)
         VALUES ($1, $2, $3, 'planned', $4)`,
        [ulid(), fixture.planId, hiddenId, state],
      );
      expect(await users.getProfile(userActor(applicantId), hiddenId)).toBeUndefined();
    }
  });

  it('keeps established visibility after a state and live-total drop', async () => {
    await t.pool.query(`UPDATE application SET state = 'declined' WHERE id = $1`, [applicationId]);
    await t.pool.query(`UPDATE plan SET accepted_guest_count = 1 WHERE id = $1`, [fixture.planId]);
    expect((await users.getProfile(userActor(secondApplicantId), applicantId))?.id).toBe(
      applicantId,
    );
  });

  it('removes the context when the application is withdrawn', async () => {
    await t.pool.query(
      `UPDATE application SET state = 'withdrawn', withdrawn_at = now() WHERE id = $1`,
      [applicationId],
    );
    expect((await users.getProfile(fixture.host, applicantId))?.id).toBe(applicantId);
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
    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      applicantId,
      secondApplicantId,
    ]);
    expect(await users.getProfile(userActor(secondApplicantId), applicantId)).toBeUndefined();
  });
});
