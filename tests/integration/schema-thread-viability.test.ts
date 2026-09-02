import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';

import { freshDb, type TestDb } from './support/db';

/**
 * The load-bearing structural guarantee (CLAUDE.md section 3, docs/modes.md):
 *
 *   - No message_thread row may exist for a non-viable plan.
 *   - No message_thread row may represent a two-individual channel.
 *
 * Both are enforced in the database, not in application code:
 *   - message_thread.plan_id -> plan.viable_plan_key  (FK to a generated column
 *     that is populated only while viable_at IS NOT NULL)
 *   - message_thread_distinct_circles_chk             (two distinct circles)
 *   - message_thread_min_participants_chk             (>= MIN_PLAN_TOTAL)
 *   - enforce_plan_guards()                           (viable_at latches)
 */

let t: TestDb;

// Shared fixture ids.
const userId = ulid();
const circleAId = ulid();
const circleBId = ulid();
const venueId = ulid();
const viablePlanId = ulid();
const nonViablePlanId = ulid();

beforeAll(async () => {
  t = await freshDb();
  const { pool } = t;

  await pool.query(
    `INSERT INTO "user" (id, first_name, verification_state, standing)
     VALUES ($1, 'Test', 'verified', 'good')`,
    [userId],
  );
  await pool.query(
    `INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'A', $3), ($2, 'B', $3)`,
    [circleAId, circleBId, userId],
  );
  await pool.query(
    `INSERT INTO venue (id, name, address, district, type)
     VALUES ($1, 'V', 'addr', 'centre', 'bar')`,
    [venueId],
  );

  // Two published plans with room for guests.
  for (const id of [viablePlanId, nonViablePlanId]) {
    await pool.query(
      `INSERT INTO plan
         (id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
          district, venue_type, state, mode)
       VALUES ($1, $2, $3, now() + interval '10 days', 5, 2,
          'centre', 'bar', 'published', 'planned')`,
      [id, circleAId, venueId],
    );
  }

  // Make exactly one of them viable: 1 confirmed host + 2 accepted guests = 3.
  await pool.query(
    `UPDATE plan
        SET confirmed_host_count = 1, accepted_guest_count = 2, viable_at = now()
      WHERE id = $1`,
    [viablePlanId],
  );
});

afterAll(async () => {
  await t?.close();
});

describe('no thread on a non-viable plan', () => {
  it('rejects a thread whose plan has never reached viability', async () => {
    await expect(
      t.pool.query(
        `INSERT INTO message_thread (id, plan_id, circle_a_id, circle_b_id, participant_count)
         VALUES ($1, $2, $3, $4, 3)`,
        [ulid(), nonViablePlanId, circleAId, circleBId],
      ),
    ).rejects.toThrow(/message_thread_plan_viable_fk/);
  });

  it('accepts a thread for a viable plan with two distinct circles and >= 3 participants', async () => {
    const threadId = ulid();
    await expect(
      t.pool.query(
        `INSERT INTO message_thread (id, plan_id, circle_a_id, circle_b_id, participant_count)
         VALUES ($1, $2, $3, $4, 3)`,
        [threadId, viablePlanId, circleAId, circleBId],
      ),
    ).resolves.toBeDefined();

    const { rows } = await t.pool.query(`SELECT plan_id FROM message_thread WHERE id = $1`, [
      threadId,
    ]);
    expect(rows[0].plan_id).toBe(viablePlanId);
  });

  it('rejects clearing viable_at once a plan has latched (the dyad cannot be un-introduced)', async () => {
    await expect(
      t.pool.query(`UPDATE plan SET viable_at = NULL WHERE id = $1`, [viablePlanId]),
    ).rejects.toThrow(/viable_at cannot be cleared/);
  });
});

describe('no two-individual thread', () => {
  it('rejects a thread with the same circle on both sides', async () => {
    await expect(
      t.pool.query(
        `INSERT INTO message_thread (id, plan_id, circle_a_id, circle_b_id, participant_count)
         VALUES ($1, $2, $3, $3, 3)`,
        [ulid(), viablePlanId, circleAId],
      ),
    ).rejects.toThrow(/message_thread_distinct_circles_chk/);
  });

  it('rejects a thread with fewer than MIN_PLAN_TOTAL participants', async () => {
    await expect(
      t.pool.query(
        `INSERT INTO message_thread (id, plan_id, circle_a_id, circle_b_id, participant_count)
         VALUES ($1, $2, $3, $4, 2)`,
        [ulid(), viablePlanId, circleAId, circleBId],
      ),
    ).rejects.toThrow(/message_thread_min_participants_chk/);
  });

  it('cannot represent a one-person thread: participant_count has no valid value below 3', async () => {
    for (const count of [0, 1, 2]) {
      await expect(
        t.pool.query(
          `INSERT INTO message_thread (id, plan_id, circle_a_id, circle_b_id, participant_count)
           VALUES ($1, $2, $3, $4, $5)`,
          [ulid(), viablePlanId, circleAId, circleBId, count],
        ),
      ).rejects.toThrow(/message_thread_min_participants_chk/);
    }
  });
});

describe('viability set-time floor', () => {
  it('rejects stamping viable_at when confirmed_total is below MIN_PLAN_TOTAL', async () => {
    const shortPlanId = ulid();
    await t.pool.query(
      `INSERT INTO plan
         (id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
          district, venue_type, state, mode)
       VALUES ($1, $2, $3, now() + interval '10 days', 5, 2,
          'centre', 'bar', 'published', 'planned')`,
      [shortPlanId, circleAId, venueId],
    );

    await expect(
      t.pool.query(
        `UPDATE plan SET confirmed_host_count = 1, accepted_guest_count = 1, viable_at = now()
          WHERE id = $1`,
        [shortPlanId],
      ),
    ).rejects.toThrow(/below MIN_PLAN_TOTAL/);
  });
});
