import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedPublishedPlan, type PlanFixture } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;
let fixture: PlanFixture;

async function addUser(name: string): Promise<string> {
  const id = ulid();
  await t.pool.query(`INSERT INTO "user" (id, first_name) VALUES ($1, $2)`, [id, name]);
  return id;
}

async function addSoloApplication(
  userId: string,
  mode: 'planned' | 'tonight',
  state: string,
): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO application (id, plan_id, solo_user_id, mode, state)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, fixture.planId, userId, mode, state],
  );
  return id;
}

beforeAll(async () => {
  t = await freshDb();
  fixture = await seedPublishedPlan(t);
});

afterAll(async () => {
  await t?.close();
});

describe('plan participant introduction ledger', () => {
  it('rejects a row before viable_at through the viable-plan foreign key', async () => {
    await expect(
      t.pool.query(
        `INSERT INTO plan_participant_introduction (id, plan_id, user_id, introduced_at)
         VALUES ($1, $2, $3, now())`,
        [ulid(), fixture.planId, fixture.hostId],
      ),
    ).rejects.toThrow(/plan_participant_introduction_plan_viable_fk/);
  });

  it('atomically records the confirmed set at viability and never removes it', async () => {
    const first = await addUser('First accepted guest');
    const second = await addUser('Second accepted guest');
    const firstApplication = await addSoloApplication(first, 'planned', 'accepted');
    await addSoloApplication(second, 'planned', 'accepted');

    await t.pool.query(
      `UPDATE plan
       SET accepted_guest_count = 2, viable_at = clock_timestamp()
       WHERE id = $1`,
      [fixture.planId],
    );

    const introduced = await t.pool.query<{ user_id: string }>(
      `SELECT user_id FROM plan_participant_introduction
       WHERE plan_id = $1 ORDER BY user_id`,
      [fixture.planId],
    );
    expect(introduced.rows.map((row) => row.user_id).sort()).toEqual(
      [fixture.hostId, first, second].sort(),
    );

    await t.pool.query(`UPDATE application SET state = 'withdrawn' WHERE id = $1`, [
      firstApplication,
    ]);
    await t.pool.query(`UPDATE plan SET accepted_guest_count = 1 WHERE id = $1`, [fixture.planId]);

    expect(
      (
        await t.pool.query<{ user_id: string }>(
          `SELECT user_id FROM plan_participant_introduction WHERE plan_id = $1`,
          [fixture.planId],
        )
      ).rows.map((row) => row.user_id),
    ).toContain(first);
  });

  it('adds later accepted participants but excludes every non-accepted state', async () => {
    const later = await addUser('Later accepted');
    const laterApplication = await addSoloApplication(later, 'planned', 'submitted');
    await t.pool.query(`UPDATE application SET state = 'accepted' WHERE id = $1`, [
      laterApplication,
    ]);
    await t.pool.query(`UPDATE plan SET accepted_guest_count = 2 WHERE id = $1`, [fixture.planId]);

    const excludedStates = [
      'draft',
      'awaiting_confirmation',
      'submitted',
      'shortlisted',
      'invited',
      'rejected',
      'declined',
      'expired',
      'withdrawn',
    ];
    const excluded: string[] = [];
    for (const state of excludedStates) {
      const userId = await addUser(`Excluded ${state}`);
      excluded.push(userId);
      await addSoloApplication(userId, 'planned', state);
    }
    await t.pool.query(
      `UPDATE plan SET confirmed_host_count = confirmed_host_count WHERE id = $1`,
      [fixture.planId],
    );

    const rows = await t.pool.query<{ user_id: string }>(
      `SELECT user_id FROM plan_participant_introduction WHERE plan_id = $1`,
      [fixture.planId],
    );
    const ids = rows.rows.map((row) => row.user_id);
    expect(ids).toContain(later);
    expect(ids).not.toEqual(expect.arrayContaining(excluded));
  });

  it('requires a compatible planned parent state for accepted circle members', async () => {
    const incompatibleStates = [
      'draft',
      'awaiting_confirmation',
      'submitted',
      'shortlisted',
      'rejected',
      'declined',
      'expired',
      'withdrawn',
    ];
    const excluded: string[] = [];
    const included: string[] = [];
    for (const state of ['invited', 'accepted']) {
      const circleId = ulid();
      const userId = await addUser(`Compatible ${state}`);
      included.push(userId);
      await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, $2, $3)`, [
        circleId,
        `Compatible circle ${state}`,
        userId,
      ]);
      const applicationId = ulid();
      await t.pool.query(
        `INSERT INTO application (id, plan_id, applicant_circle_id, mode, state)
         VALUES ($1, $2, $3, 'planned', $4)`,
        [applicationId, fixture.planId, circleId, state],
      );
      await t.pool.query(
        `INSERT INTO application_member
           (id, application_id, user_id, invitation_state)
         VALUES ($1, $2, $3, 'accepted')`,
        [ulid(), applicationId, userId],
      );
    }
    for (const state of incompatibleStates) {
      const circleId = ulid();
      const userId = await addUser(`Stale ${state}`);
      excluded.push(userId);
      await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, $2, $3)`, [
        circleId,
        `Circle ${state}`,
        userId,
      ]);
      const applicationId = ulid();
      await t.pool.query(
        `INSERT INTO application (id, plan_id, applicant_circle_id, mode, state)
         VALUES ($1, $2, $3, 'planned', $4)`,
        [applicationId, fixture.planId, circleId, state],
      );
      await t.pool.query(
        `INSERT INTO application_member
           (id, application_id, user_id, invitation_state)
         VALUES ($1, $2, $3, 'accepted')`,
        [ulid(), applicationId, userId],
      );
    }
    await t.pool.query(
      `UPDATE plan SET confirmed_host_count = confirmed_host_count WHERE id = $1`,
      [fixture.planId],
    );
    const rows = await t.pool.query<{ user_id: string }>(
      `SELECT user_id FROM plan_participant_introduction WHERE plan_id = $1`,
      [fixture.planId],
    );
    const ids = rows.rows.map((row) => row.user_id);
    expect(ids).toEqual(expect.arrayContaining(included));
    expect(ids).not.toEqual(expect.arrayContaining(excluded));
  });

  it('populates tonight solo and included circle applicants only after approval', async () => {
    const solo = await addUser('Tonight solo');
    const submitted = await addUser('Tonight submitted');
    await addSoloApplication(solo, 'tonight', 'approved');
    await addSoloApplication(submitted, 'tonight', 'submitted');

    const circleLead = await addUser('Tonight circle lead');
    const circleMember = await addUser('Tonight circle member');
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
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = accepted_guest_count WHERE id = $1`,
      [fixture.planId],
    );

    const ids = (
      await t.pool.query<{ user_id: string }>(
        `SELECT user_id FROM plan_participant_introduction WHERE plan_id = $1`,
        [fixture.planId],
      )
    ).rows.map((row) => row.user_id);
    expect(ids).toEqual(expect.arrayContaining([solo, circleLead, circleMember]));
    expect(ids).not.toContain(submitted);
  });

  it('rejects updates and deletes even for the bootstrap owner', async () => {
    await expect(
      t.pool.query(
        `UPDATE plan_participant_introduction
         SET introduced_at = now() WHERE plan_id = $1`,
        [fixture.planId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      t.pool.query(`DELETE FROM plan_participant_introduction WHERE plan_id = $1`, [
        fixture.planId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('serializes simultaneous acceptance and viability without a partial ledger', async () => {
    const concurrent = await seedPublishedPlan(t);
    await t.pool.query(`UPDATE plan SET open_spots = 3 WHERE id = $1`, [concurrent.planId]);
    const existing = await addUser('Existing confirmed guest');
    const first = await addUser('Concurrent first');
    const second = await addUser('Concurrent second');
    const applicationIds = [ulid(), ulid(), ulid()];
    await t.pool.query(
      `INSERT INTO application (id, plan_id, solo_user_id, mode, state)
       VALUES ($1, $4, $5, 'planned', 'accepted'),
              ($2, $4, $6, 'planned', 'submitted'),
              ($3, $4, $7, 'planned', 'submitted')`,
      [
        applicationIds[0],
        applicationIds[1],
        applicationIds[2],
        concurrent.planId,
        existing,
        first,
        second,
      ],
    );
    await t.pool.query(`UPDATE plan SET accepted_guest_count = 1 WHERE id = $1`, [
      concurrent.planId,
    ]);

    const firstClient = await t.pool.connect();
    const secondClient = await t.pool.connect();
    try {
      await firstClient.query('BEGIN');
      await secondClient.query('BEGIN');
      await firstClient.query(`SELECT id FROM plan WHERE id = $1 FOR UPDATE`, [concurrent.planId]);
      const secondLock = secondClient.query(`SELECT id FROM plan WHERE id = $1 FOR UPDATE`, [
        concurrent.planId,
      ]);

      await firstClient.query(`UPDATE application SET state = 'accepted' WHERE id = $1`, [
        applicationIds[1],
      ]);
      await firstClient.query(
        `UPDATE plan
         SET accepted_guest_count = accepted_guest_count + 1,
             viable_at = COALESCE(viable_at, clock_timestamp())
         WHERE id = $1`,
        [concurrent.planId],
      );
      await firstClient.query('COMMIT');

      await secondLock;
      await secondClient.query(`UPDATE application SET state = 'accepted' WHERE id = $1`, [
        applicationIds[2],
      ]);
      await secondClient.query(
        `UPDATE plan SET accepted_guest_count = accepted_guest_count + 1 WHERE id = $1`,
        [concurrent.planId],
      );
      await secondClient.query('COMMIT');
    } catch (error) {
      await firstClient.query('ROLLBACK');
      await secondClient.query('ROLLBACK');
      throw error;
    } finally {
      firstClient.release();
      secondClient.release();
    }

    const rows = await t.pool.query<{ user_id: string }>(
      `SELECT user_id FROM plan_participant_introduction WHERE plan_id = $1`,
      [concurrent.planId],
    );
    expect(rows.rows.map((row) => row.user_id).sort()).toEqual(
      [concurrent.hostId, existing, first, second].sort(),
    );
  });
});
