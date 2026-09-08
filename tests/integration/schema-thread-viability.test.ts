import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';

import { freshDb, type TestDb } from './support/db';

/**
 * The load-bearing structural guarantee (docs/agent-rules.md section 3, docs/modes.md):
 *
 *   - No message_thread row may exist for a non-viable plan.
 *   - No message_thread row may represent a two-individual channel.
 *
 * Both are enforced in the database, not in application code. After C8
 * (migration 0012) dropped the circle_a_id / circle_b_id columns (see
 * docs/state.md Decisions C8), the anti-dyad guarantee rests on:
 *
 *   - message_thread.plan_id -> plan.viable_plan_key  (FK to a generated column
 *     populated only while viable_at IS NOT NULL)
 *   - message_thread_min_participants_chk             (>= MIN_PLAN_TOTAL)
 *   - participant_count is trigger-maintained from plan_participant_introduction
 *     (0012), so it is the real introduced-attendee count, not a number the
 *     inserter chose
 *   - enforce_plan_guards()                           (viable_at latches; the
 *     set-time floor is on confirmed_total)
 */

let t: TestDb;

const hostA = ulid();
const hostB = ulid();
const hostC = ulid();
const soloHost = ulid();
const extraUser = ulid();
const bigCircleId = ulid();
const soloCircleId = ulid();
const venueId = ulid();
const viablePlanId = ulid();
const nonViablePlanId = ulid();
const shortLedgerPlanId = ulid();

beforeAll(async () => {
  t = await freshDb();
  const { pool } = t;

  await pool.query(
    `INSERT INTO "user" (id, first_name, verification_state, standing)
     VALUES ($1,'A','verified','good'),($2,'B','verified','good'),($3,'C','verified','good'),
            ($4,'S','verified','good'),($5,'E','verified','good')`,
    [hostA, hostB, hostC, soloHost, extraUser],
  );
  await pool.query(
    `INSERT INTO circle (id, name, lead_user_id) VALUES ($1,'Big',$2),($3,'Solo',$4)`,
    [bigCircleId, hostA, soloCircleId, soloHost],
  );
  await pool.query(
    `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
     VALUES ($1,$2,$3,'lead','active',now()),($4,$2,$5,'member','active',now()),
            ($6,$2,$7,'member','active',now()),($8,$9,$10,'lead','active',now())`,
    [ulid(), bigCircleId, hostA, ulid(), hostB, ulid(), hostC, ulid(), soloCircleId, soloHost],
  );
  await pool.query(
    `INSERT INTO venue (id, name, address, district, type) VALUES ($1,'V','addr','centre','bar')`,
    [venueId],
  );

  // Three published plans with room for guests.
  for (const [id, circleId] of [
    [viablePlanId, bigCircleId],
    [nonViablePlanId, bigCircleId],
    [shortLedgerPlanId, soloCircleId],
  ] as const) {
    await pool.query(
      `INSERT INTO plan (id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
                         district, venue_type, state, mode)
       VALUES ($1,$2,$3, now() + interval '10 days', 5, 2, 'centre','bar','published','planned')`,
      [id, circleId, venueId],
    );
  }

  // viablePlan: 3 active host members -> viability latches -> the reconcile
  // trigger writes 3 ledger rows. accepted_guest_count = 1 satisfies the
  // Decision B set-time floor (C7c); no guest application is needed for these
  // thread-shape tests, so the ledger stays at the 3 real host members.
  await pool.query(
    `UPDATE plan SET confirmed_host_count = 3, accepted_guest_count = 1, viable_at = now() WHERE id = $1`,
    [viablePlanId],
  );
  // shortLedgerPlan: counters say viable (set-time floor is on the counters),
  // but the host circle has ONE active member, so the ledger gets one row.
  await pool.query(
    `UPDATE plan SET confirmed_host_count = 3, accepted_guest_count = 1, viable_at = now() WHERE id = $1`,
    [shortLedgerPlanId],
  );
});

afterAll(async () => {
  await t?.close();
});

async function ledgerCount(planId: string): Promise<number> {
  const { rows } = await t.pool.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM plan_participant_introduction WHERE plan_id = $1`,
    [planId],
  );
  return Number(rows[0]?.n);
}

describe('no thread on a non-viable plan', () => {
  it('rejects a thread whose plan has never reached viability, twice over', async () => {
    // Two independent guards refuse it. The trigger sets participant_count from
    // the ledger, which is structurally empty for a non-viable plan (its rows
    // FK to viable_plan_key too), so message_thread_min_participants_chk is the
    // first to fire; the FK to plan.viable_plan_key is the deeper backstop.
    await expect(
      t.pool.query(
        `INSERT INTO message_thread (id, plan_id, participant_count) VALUES ($1, $2, 3)`,
        [ulid(), nonViablePlanId],
      ),
    ).rejects.toThrow(/message_thread_(min_participants_chk|plan_viable_fk)/);

    const { rows } = await t.pool.query<{ viable_plan_key: string | null }>(
      `SELECT viable_plan_key FROM plan WHERE id = $1`,
      [nonViablePlanId],
    );
    expect(rows[0]?.viable_plan_key).toBeNull(); // the FK could never find a target
  });

  it('accepts one thread for a viable plan and fills participant_count from the ledger', async () => {
    expect(await ledgerCount(viablePlanId)).toBe(3);
    const threadId = ulid();
    await expect(
      t.pool.query(
        `INSERT INTO message_thread (id, plan_id, participant_count) VALUES ($1, $2, 999)`,
        [threadId, viablePlanId],
      ),
    ).resolves.toBeDefined();

    const { rows } = await t.pool.query<{ plan_id: string; participant_count: number }>(
      `SELECT plan_id, participant_count FROM message_thread WHERE id = $1`,
      [threadId],
    );
    expect(rows[0]?.plan_id).toBe(viablePlanId);
    expect(rows[0]?.participant_count).toBe(3); // the supplied 999 is ignored
  });

  it('allows only one thread per plan', async () => {
    await expect(
      t.pool.query(
        `INSERT INTO message_thread (id, plan_id, participant_count) VALUES ($1, $2, 3)`,
        [ulid(), viablePlanId],
      ),
    ).rejects.toThrow(/message_thread_plan_uq/);
  });

  it('rejects clearing viable_at once a plan has latched (the dyad cannot be un-introduced)', async () => {
    await expect(
      t.pool.query(`UPDATE plan SET viable_at = NULL WHERE id = $1`, [viablePlanId]),
    ).rejects.toThrow(/viable_at cannot be cleared/);
  });
});

describe('the anti-dyad guarantee is participant_count >= 3, not a circle count', () => {
  it('rejects a thread for a viable-flagged plan whose ledger is short of MIN_PLAN_TOTAL', async () => {
    // The counters latched viable_at (set-time floor is on confirmed_total),
    // but only one real host member exists, so the ledger — and the
    // trigger-set participant_count — is 1.
    expect(await ledgerCount(shortLedgerPlanId)).toBe(1);
    await expect(
      t.pool.query(
        `INSERT INTO message_thread (id, plan_id, participant_count) VALUES ($1, $2, 5)`,
        [ulid(), shortLedgerPlanId],
      ),
    ).rejects.toThrow(/message_thread_min_participants_chk/);
  });

  it('resyncs participant_count when the ledger grows for a plan that has a thread', async () => {
    const before = (
      await t.pool.query<{ participant_count: number }>(
        `SELECT participant_count FROM message_thread WHERE plan_id = $1`,
        [viablePlanId],
      )
    ).rows[0]?.participant_count;
    expect(before).toBe(3);

    await t.pool.query(
      `INSERT INTO plan_participant_introduction (id, plan_id, user_id, introduced_at)
       VALUES ($1, $2, $3, now())`,
      [ulid(), viablePlanId, extraUser],
    );

    const after = (
      await t.pool.query<{ participant_count: number }>(
        `SELECT participant_count FROM message_thread WHERE plan_id = $1`,
        [viablePlanId],
      )
    ).rows[0]?.participant_count;
    expect(after).toBe(4);
  });
});

describe('viability set-time floor', () => {
  it('rejects stamping viable_at when confirmed_total is below MIN_PLAN_TOTAL', async () => {
    const shortPlanId = ulid();
    await t.pool.query(
      `INSERT INTO plan (id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
                         district, venue_type, state, mode)
       VALUES ($1, $2, $3, now() + interval '10 days', 5, 2, 'centre','bar','published','planned')`,
      [shortPlanId, bigCircleId, venueId],
    );
    await expect(
      t.pool.query(
        `UPDATE plan SET confirmed_host_count = 1, accepted_guest_count = 1, viable_at = now()
          WHERE id = $1`,
        [shortPlanId],
      ),
    ).rejects.toThrow(/below MIN_PLAN_TOTAL/);
  });

  it('rejects stamping viable_at for a host circle alone with zero accepted guests (Decision B, C7c)', async () => {
    const hostOnlyPlanId = ulid();
    await t.pool.query(
      `INSERT INTO plan (id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
                         district, venue_type, state, mode)
       VALUES ($1, $2, $3, now() + interval '10 days', 5, 2, 'centre','bar','published','planned')`,
      [hostOnlyPlanId, bigCircleId, venueId],
    );
    await expect(
      t.pool.query(
        `UPDATE plan SET confirmed_host_count = 5, accepted_guest_count = 0, viable_at = now()
          WHERE id = $1`,
        [hostOnlyPlanId],
      ),
    ).rejects.toThrow(/MIN_PLAN_TOTAL or with no accepted guest/);
  });
});
