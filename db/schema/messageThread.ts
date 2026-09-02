import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

import { softDelete, timestamps, ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { circle } from './circle';

/**
 * A circle-to-circle thread scoped to a plan. Created ON VIABILITY, never on
 * invitation or approval (docs/modes.md, docs/agent-rules.md section 3).
 *
 * "No thread on a non-viable plan" is structural, not a code check:
 * `plan_id` references `plan.viable_plan_key` — a generated column that equals
 * the plan id only while `viable_at IS NOT NULL`. That FK, the `>= 3`
 * participant check, and the `viable_at` latch trigger all live in
 * 0001_guards.sql. Here we get: two distinct non-null circle references, and a
 * ULID-shaped `plan_id`.
 *
 * A two-individual thread cannot be represented: there is no participant column
 * that could hold one person, `circle_a_id <> circle_b_id` is required, and the
 * viability gate guarantees at least MIN_PLAN_TOTAL confirmed attendees behind
 * any thread that exists.
 */
export const messageThread = pgTable(
  'message_thread',
  {
    id: ulidPrimaryKey(),
    // FK -> plan(viable_plan_key), added in 0001_guards.sql.
    planId: ulidColumn('plan_id').notNull(),
    circleAId: ulidColumn('circle_a_id')
      .notNull()
      .references(() => circle.id, { onDelete: 'restrict' }),
    circleBId: ulidColumn('circle_b_id')
      .notNull()
      .references(() => circle.id, { onDelete: 'restrict' }),
    // CHECK (participant_count >= 3) added in 0001_guards.sql (annotated MIN_PLAN_TOTAL literal).
    participantCount: integer('participant_count').notNull(),
    /** Set at plan completion; the retention worker deletes the thread after this. */
    retentionDeleteAfter: timestamp('retention_delete_after', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    ulidFormatCheck('message_thread_id_ulid_chk', t.id),
    ulidFormatCheck('message_thread_plan_id_ulid_chk', t.planId),
    check('message_thread_distinct_circles_chk', sql`${t.circleAId} <> ${t.circleBId}`),
    index('message_thread_plan_idx').on(t.planId),
    index('message_thread_circle_a_idx').on(t.circleAId),
    index('message_thread_circle_b_idx').on(t.circleBId),
  ],
);
