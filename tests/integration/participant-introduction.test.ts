import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedPublishedPlan, type PlanFixture } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;

async function addUser(name: string): Promise<string> {
  const id = ulid();
  await t.pool.query(`INSERT INTO "user" (id, first_name) VALUES ($1, $2)`, [id, name]);
  return id;
}

async function addSoloApplication(
  planId: string,
  userId: string,
  mode: 'planned' | 'tonight',
  state: string,
): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO application (id, plan_id, solo_user_id, mode, state)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, planId, userId, mode, state],
  );
  return id;
}

async function introducedUsers(planId: string): Promise<string[]> {
  return (
    await t.pool.query<{ user_id: string }>(
      `SELECT user_id FROM plan_participant_introduction WHERE plan_id = $1 ORDER BY user_id`,
      [planId],
    )
  ).rows.map((row) => row.user_id);
}

async function makeViable(fixture: PlanFixture): Promise<void> {
  // accepted_guest_count = 1 satisfies the Decision B set-time floor (C7c). The
  // ledger population reads real circle_member / application rows, not these
  // counters, so this does not add anyone to the introduction ledger.
  await t.pool.query(
    `UPDATE plan SET confirmed_host_count = 3, accepted_guest_count = 1, viable_at = clock_timestamp() WHERE id = $1`,
    [fixture.planId],
  );
}

beforeAll(async () => {
  t = await freshDb();
});

afterAll(async () => {
  await t?.close();
});

describe('plan participant introduction ledger', () => {
  it('rejects a row before viable_at through the viable-plan foreign key', async () => {
    const fixture = await seedPublishedPlan(t);
    await expect(
      t.pool.query(
        `INSERT INTO plan_participant_introduction (id, plan_id, user_id, introduced_at)
         VALUES ($1, $2, $3, now())`,
        [ulid(), fixture.planId, fixture.hostId],
      ),
    ).rejects.toThrow(/plan_participant_introduction_plan_viable_fk/);
  });

  it('atomically records the confirmed set at viability and never removes it', async () => {
    const fixture = await seedPublishedPlan(t);
    const first = await addUser('First accepted guest');
    const second = await addUser('Second accepted guest');
    const firstApplication = await addSoloApplication(fixture.planId, first, 'planned', 'accepted');
    await addSoloApplication(fixture.planId, second, 'planned', 'accepted');
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = 2, viable_at = clock_timestamp() WHERE id = $1`,
      [fixture.planId],
    );
    expect(await introducedUsers(fixture.planId)).toEqual([fixture.hostId, first, second].sort());
    await t.pool.query(`UPDATE application SET state = 'withdrawn' WHERE id = $1`, [
      firstApplication,
    ]);
    await t.pool.query(`UPDATE plan SET accepted_guest_count = 1 WHERE id = $1`, [fixture.planId]);
    expect(await introducedUsers(fixture.planId)).toContain(first);
  });

  it('adds later accepted participants but excludes every non-accepted state', async () => {
    const fixture = await seedPublishedPlan(t);
    await makeViable(fixture);
    const later = await addUser('Later accepted');
    const laterApplication = await addSoloApplication(
      fixture.planId,
      later,
      'planned',
      'submitted',
    );
    await t.pool.query(`UPDATE application SET state = 'accepted' WHERE id = $1`, [
      laterApplication,
    ]);
    const excluded: string[] = [];
    for (const state of [
      'draft',
      'awaiting_confirmation',
      'submitted',
      'shortlisted',
      'invited',
      'rejected',
      'declined',
      'expired',
      'withdrawn',
    ]) {
      const userId = await addUser(`Excluded ${state}`);
      excluded.push(userId);
      await addSoloApplication(fixture.planId, userId, 'planned', state);
    }
    const ids = await introducedUsers(fixture.planId);
    expect(ids).toContain(later);
    expect(ids).not.toEqual(expect.arrayContaining(excluded));
  });

  it('rejects stale accepted planned-circle members under every incompatible parent state', async () => {
    const fixture = await seedPublishedPlan(t);
    await makeViable(fixture);
    const excluded: string[] = [];
    const included: string[] = [];
    for (const state of ['invited', 'accepted']) {
      const circleId = ulid();
      const userId = await addUser(`Compatible ${state}`);
      included.push(userId);
      await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, $2, $3)`, [
        circleId,
        `Compatible ${state}`,
        userId,
      ]);
      const applicationId = ulid();
      await t.pool.query(
        `INSERT INTO application (id, plan_id, applicant_circle_id, mode, state)
         VALUES ($1, $2, $3, 'planned', $4)`,
        [applicationId, fixture.planId, circleId, state],
      );
      await t.pool.query(
        `INSERT INTO application_member (id, application_id, user_id, invitation_state)
         VALUES ($1, $2, $3, 'accepted')`,
        [ulid(), applicationId, userId],
      );
    }
    for (const state of [
      'draft',
      'awaiting_confirmation',
      'submitted',
      'shortlisted',
      'rejected',
      'declined',
      'expired',
      'withdrawn',
    ]) {
      const circleId = ulid();
      const userId = await addUser(`Stale ${state}`);
      excluded.push(userId);
      await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, $2, $3)`, [
        circleId,
        `Stale ${state}`,
        userId,
      ]);
      const applicationId = ulid();
      await t.pool.query(
        `INSERT INTO application (id, plan_id, applicant_circle_id, mode, state)
         VALUES ($1, $2, $3, 'planned', $4)`,
        [applicationId, fixture.planId, circleId, state],
      );
      await t.pool.query(
        `INSERT INTO application_member (id, application_id, user_id, invitation_state)
         VALUES ($1, $2, $3, 'accepted')`,
        [ulid(), applicationId, userId],
      );
    }
    const ids = await introducedUsers(fixture.planId);
    expect(ids).toEqual(expect.arrayContaining(included));
    expect(ids).not.toEqual(expect.arrayContaining(excluded));
  });

  it('populates only approved tonight solo users and included circle members', async () => {
    const fixture = await seedPublishedPlan(t);
    await makeViable(fixture);
    const solo = await addUser('Tonight solo');
    const submitted = await addUser('Tonight submitted');
    await addSoloApplication(fixture.planId, solo, 'tonight', 'approved');
    await addSoloApplication(fixture.planId, submitted, 'tonight', 'submitted');
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
        `INSERT INTO application_member (id, application_id, user_id) VALUES ($1, $2, $3)`,
        [ulid(), applicationId, userId],
      );
    }
    const ids = await introducedUsers(fixture.planId);
    expect(ids).toEqual(expect.arrayContaining([solo, circleLead, circleMember]));
    expect(ids).not.toContain(submitted);
  });

  it('rejects updates and deletes even for the bootstrap owner', async () => {
    const fixture = await seedPublishedPlan(t);
    await makeViable(fixture);
    await expect(
      t.pool.query(
        `UPDATE plan_participant_introduction SET introduced_at = now() WHERE plan_id = $1`,
        [fixture.planId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      t.pool.query(`DELETE FROM plan_participant_introduction WHERE plan_id = $1`, [
        fixture.planId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('makes an application transition wait on the plan-first lock and completes the ledger', async () => {
    const fixture = await seedPublishedPlan(t);
    const existing = await addUser('Existing confirmed guest');
    const concurrent = await addUser('Concurrent accepted guest');
    await addSoloApplication(fixture.planId, existing, 'planned', 'accepted');
    const concurrentApplication = await addSoloApplication(
      fixture.planId,
      concurrent,
      'planned',
      'submitted',
    );
    await t.pool.query(`UPDATE plan SET accepted_guest_count = 1 WHERE id = $1`, [fixture.planId]);
    const first = await t.pool.connect();
    const second = await t.pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query(`SELECT id FROM plan WHERE id = $1 FOR UPDATE`, [fixture.planId]);
      const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid;
      const transition = second.query(`UPDATE application SET state = 'accepted' WHERE id = $1`, [
        concurrentApplication,
      ]);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        waiting =
          (
            await t.pool.query<{ waiting: boolean }>(
              `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
              [secondPid],
            )
          ).rows[0]?.waiting ?? false;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await first.query(
        `UPDATE plan SET accepted_guest_count = 2, viable_at = clock_timestamp() WHERE id = $1`,
        [fixture.planId],
      );
      await first.query('COMMIT');
      await transition;
      await second.query('COMMIT');
    } catch (error) {
      await first.query('ROLLBACK');
      await second.query('ROLLBACK');
      throw error;
    } finally {
      first.release();
      second.release();
    }
    expect(await introducedUsers(fixture.planId)).toEqual(
      [fixture.hostId, existing, concurrent].sort(),
    );
  });

  it('rolls application state, counters, viability, and introductions back together', async () => {
    const fixture = await seedPublishedPlan(t);
    const first = await addUser('Rollback accepted one');
    const second = await addUser('Rollback accepted two');
    const firstApplication = await addSoloApplication(
      fixture.planId,
      first,
      'planned',
      'submitted',
    );
    const secondApplication = await addSoloApplication(
      fixture.planId,
      second,
      'planned',
      'submitted',
    );
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM plan WHERE id = $1 FOR UPDATE`, [fixture.planId]);
      await client.query(`UPDATE application SET state = 'accepted' WHERE id IN ($1, $2)`, [
        firstApplication,
        secondApplication,
      ]);
      await client.query(
        `UPDATE plan SET accepted_guest_count = 2, viable_at = clock_timestamp() WHERE id = $1`,
        [fixture.planId],
      );
      expect(
        (
          await client.query(`SELECT * FROM plan_participant_introduction WHERE plan_id = $1`, [
            fixture.planId,
          ])
        ).rowCount,
      ).toBe(3);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const applications = await t.pool.query<{ state: string }>(
      `SELECT state FROM application WHERE id IN ($1, $2) ORDER BY id`,
      [firstApplication, secondApplication],
    );
    expect(applications.rows.map((row) => row.state)).toEqual(['submitted', 'submitted']);
    const plan = await t.pool.query<{ accepted_guest_count: number; viable_at: Date | null }>(
      `SELECT accepted_guest_count, viable_at FROM plan WHERE id = $1`,
      [fixture.planId],
    );
    expect(plan.rows[0]).toEqual({ accepted_guest_count: 0, viable_at: null });
    expect(await introducedUsers(fixture.planId)).toEqual([]);
  });
});
