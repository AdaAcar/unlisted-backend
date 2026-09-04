import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { users } from '@/db/repositories';

import { seedPublishedPlan, userActor } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;

async function addUser(name: string): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state)
                      VALUES ($1, $2, 'verified')`,
    [id, name],
  );
  return id;
}

async function addSolo(planId: string, userId: string, mode: 'planned' | 'tonight', state: string) {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO application (id, plan_id, solo_user_id, mode, state, submitted_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [id, planId, userId, mode, state],
  );
  return id;
}

async function viableWithAcceptedGuests(planId: string, guestIds: string[]): Promise<void> {
  for (const guestId of guestIds) await addSolo(planId, guestId, 'planned', 'accepted');
  await t.pool.query(
    `UPDATE plan SET accepted_guest_count = $2, viable_at = clock_timestamp() WHERE id = $1`,
    [planId, guestIds.length],
  );
}

beforeAll(async () => {
  t = await freshDb();
});

afterAll(async () => {
  await t?.close();
});

describe('profile shared-plan context', () => {
  it('preserves host-to-applicant review visibility in both directions before viability', async () => {
    const fixture = await seedPublishedPlan(t);
    const applicantId = await addUser('Applicant');
    const applicationId = await addSolo(fixture.planId, applicantId, 'planned', 'submitted');
    expect((await users.getProfile(fixture.host, applicantId))?.id).toBe(applicantId);
    expect((await users.getProfile(userActor(applicantId), fixture.hostId))?.id).toBe(
      fixture.hostId,
    );
    await t.pool.query(`UPDATE application SET state = 'rejected' WHERE id = $1`, [applicationId]);
    expect((await users.getProfile(fixture.host, applicantId))?.id).toBe(applicantId);
    expect((await users.getProfile(userActor(applicantId), fixture.hostId))?.id).toBe(
      fixture.hostId,
    );
    expect(
      (
        await t.pool.query<{ viable_at: Date | null }>(`SELECT viable_at FROM plan WHERE id = $1`, [
          fixture.planId,
        ])
      ).rows[0]?.viable_at,
    ).toBeNull();
  });

  it('denies applicants in both directions before viability, even when both are accepted', async () => {
    const fixture = await seedPublishedPlan(t);
    const first = await addUser('Accepted before viability A');
    const second = await addUser('Accepted before viability B');
    await addSolo(fixture.planId, first, 'planned', 'accepted');
    await addSolo(fixture.planId, second, 'planned', 'accepted');
    expect(await users.getProfile(userActor(first), second)).toBeUndefined();
    expect(await users.getProfile(userActor(second), first)).toBeUndefined();
  });

  it('returns not-found semantics to an actor without shared plan context', async () => {
    const fixture = await seedPublishedPlan(t);
    const applicantId = await addUser('Applicant');
    const outsiderId = await addUser('Outsider');
    await addSolo(fixture.planId, applicantId, 'planned', 'submitted');
    expect(await users.getProfile(userActor(outsiderId), applicantId)).toBeUndefined();
  });

  it('removes never-ledgered host review context when an application is withdrawn', async () => {
    const fixture = await seedPublishedPlan(t);
    const applicantId = await addUser('Withdrawn before introduction');
    const applicationId = await addSolo(fixture.planId, applicantId, 'planned', 'submitted');
    expect((await users.getProfile(fixture.host, applicantId))?.id).toBe(applicantId);
    expect((await users.getProfile(userActor(applicantId), fixture.hostId))?.id).toBe(
      fixture.hostId,
    );
    await t.pool.query(
      `UPDATE application SET state = 'withdrawn', withdrawn_at = now() WHERE id = $1`,
      [applicationId],
    );
    expect(await users.getProfile(fixture.host, applicantId)).toBeUndefined();
    expect(await users.getProfile(userActor(applicantId), fixture.hostId)).toBeUndefined();
  });

  it('keeps ledgered visibility after withdrawal and a live-total drop', async () => {
    const fixture = await seedPublishedPlan(t);
    const first = await addUser('Introduced then withdrawn');
    const second = await addUser('Introduced peer');
    const firstApplication = await addSolo(fixture.planId, first, 'planned', 'accepted');
    await addSolo(fixture.planId, second, 'planned', 'accepted');
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = 2, viable_at = clock_timestamp() WHERE id = $1`,
      [fixture.planId],
    );
    await t.pool.query(
      `UPDATE application SET state = 'withdrawn', withdrawn_at = now() WHERE id = $1`,
      [firstApplication],
    );
    await t.pool.query(`UPDATE plan SET accepted_guest_count = 1 WHERE id = $1`, [fixture.planId]);
    expect((await users.getProfile(userActor(second), first))?.id).toBe(first);
    expect((await users.getProfile(userActor(first), second))?.id).toBe(second);
  });

  it('makes planned-circle accepted members mutual only after the ledger records them', async () => {
    const fixture = await seedPublishedPlan(t);
    const first = await addUser('Planned circle A');
    const second = await addUser('Planned circle B');
    const circleId = ulid();
    await t.pool.query(
      `INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'Applicants', $2)`,
      [circleId, first],
    );
    const applicationId = ulid();
    await t.pool.query(
      `INSERT INTO application (id, plan_id, applicant_circle_id, mode, state)
       VALUES ($1, $2, $3, 'planned', 'invited')`,
      [applicationId, fixture.planId, circleId],
    );
    for (const userId of [first, second]) {
      await t.pool.query(
        `INSERT INTO application_member (id, application_id, user_id, invitation_state)
         VALUES ($1, $2, $3, 'accepted')`,
        [ulid(), applicationId, userId],
      );
    }
    expect(await users.getProfile(userActor(first), second)).toBeUndefined();
    expect(await users.getProfile(userActor(second), first)).toBeUndefined();
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = 2, viable_at = clock_timestamp() WHERE id = $1`,
      [fixture.planId],
    );
    expect((await users.getProfile(userActor(first), second))?.id).toBe(second);
    expect((await users.getProfile(userActor(second), first))?.id).toBe(first);
  });

  it('makes approved tonight solo and included circle members mutual only after ledgering', async () => {
    const fixture = await seedPublishedPlan(t);
    await t.pool.query(`UPDATE plan SET open_spots = 3 WHERE id = $1`, [fixture.planId]);
    const solo = await addUser('Tonight solo');
    const circleLead = await addUser('Tonight circle lead');
    const circleMember = await addUser('Tonight circle member');
    await addSolo(fixture.planId, solo, 'tonight', 'approved');
    const circleId = ulid();
    await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'Tonight', $2)`, [
      circleId,
      circleLead,
    ]);
    const applicationId = ulid();
    await t.pool.query(
      `INSERT INTO application (id, plan_id, applicant_circle_id, mode, state)
       VALUES ($1, $2, $3, 'tonight', 'approved')`,
      [applicationId, fixture.planId, circleId],
    );
    for (const userId of [circleLead, circleMember]) {
      await t.pool.query(
        `INSERT INTO application_member (id, application_id, user_id)
         VALUES ($1, $2, $3)`,
        [ulid(), applicationId, userId],
      );
    }
    expect(await users.getProfile(userActor(solo), circleLead)).toBeUndefined();
    expect(await users.getProfile(userActor(circleMember), solo)).toBeUndefined();
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = 3, viable_at = clock_timestamp() WHERE id = $1`,
      [fixture.planId],
    );
    expect((await users.getProfile(userActor(solo), circleLead))?.id).toBe(circleLead);
    expect((await users.getProfile(userActor(circleMember), solo))?.id).toBe(solo);
  });

  it('keeps every non-participant state hidden from an introduced guest', async () => {
    const fixture = await seedPublishedPlan(t);
    const actorId = await addUser('Introduced actor');
    const companionId = await addUser('Introduced companion');
    await viableWithAcceptedGuests(fixture.planId, [actorId, companionId]);
    for (const state of [
      'submitted',
      'shortlisted',
      'invited',
      'rejected',
      'declined',
      'expired',
      'withdrawn',
    ]) {
      const hiddenId = await addUser(`Hidden ${state}`);
      await addSolo(fixture.planId, hiddenId, 'planned', state);
      expect(await users.getProfile(userActor(actorId), hiddenId)).toBeUndefined();
      expect(await users.getProfile(userActor(hiddenId), actorId)).toBeUndefined();
    }
  });

  it('does not treat accepted current rows without a common ledger as participant context', async () => {
    const fixture = await seedPublishedPlan(t);
    const first = await addUser('Accepted unlatched A');
    const second = await addUser('Accepted unlatched B');
    await addSolo(fixture.planId, first, 'planned', 'accepted');
    await addSolo(fixture.planId, second, 'planned', 'accepted');
    expect(
      (
        await t.pool.query(`SELECT * FROM plan_participant_introduction WHERE plan_id = $1`, [
          fixture.planId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await users.getProfile(userActor(first), second)).toBeUndefined();
    expect(await users.getProfile(userActor(second), first)).toBeUndefined();
  });

  it('lets a bidirectional block override an existing introduction', async () => {
    const fixture = await seedPublishedPlan(t);
    const first = await addUser('Blocked introduced A');
    const second = await addUser('Blocked introduced B');
    await viableWithAcceptedGuests(fixture.planId, [first, second]);
    expect((await users.getProfile(userActor(first), second))?.id).toBe(second);
    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      second,
      first,
    ]);
    expect(await users.getProfile(userActor(first), second)).toBeUndefined();
    expect(await users.getProfile(userActor(second), first)).toBeUndefined();
  });
});
