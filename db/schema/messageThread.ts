import { integer, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { softDelete, timestamps, ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';

/**
 * A thread scoped to a plan. Created ON VIABILITY, never on invitation or
 * approval (docs/modes.md, docs/agent-rules.md section 3).
 *
 * "No thread on a non-viable plan" is structural, not a code check:
 * `plan_id` references `plan.viable_plan_key` — a generated column that equals
 * the plan id only while `viable_at IS NOT NULL`. That FK, the `>= 3`
 * participant check, and the `viable_at` latch trigger all live in
 * 0001_guards.sql.
 *
 * C8 (migration 0012) dropped the original `circle_a_id` / `circle_b_id`
 * columns and their `<>` check. That circle-to-circle shape predated the
 * two-mode design and never was the anti-dyad guarantee — with
 * `MIN_HOST_CIRCLE = 1`, two distinct circles of one member each are a
 * two-person thread that satisfies `circle_a_id <> circle_b_id`. A dyad is
 * barred only by `participant_count >= 3` plus the FK to a plan whose
 * `confirmed_total` was `>= MIN_PLAN_TOTAL` when `viable_at` latched. The
 * thread is now plain plan-scoped; its participant set comes from
 * `plan_participant_introduction`. See docs/state.md Decisions C8 and the §3
 * exception recorded there.
 *
 * `participant_count` is trigger-maintained from `plan_participant_introduction`
 * (0012): set from the ledger on INSERT, resynced when the ledger grows. The
 * application never writes it, so `>= 3` stays a property of the data.
 */
export const messageThread = pgTable(
  'message_thread',
  {
    id: ulidPrimaryKey(),
    // FK -> plan(viable_plan_key), added in 0001_guards.sql.
    planId: ulidColumn('plan_id').notNull(),
    // CHECK (participant_count >= 3) added in 0001_guards.sql (annotated MIN_PLAN_TOTAL literal).
    // Trigger-maintained from plan_participant_introduction (0012).
    participantCount: integer('participant_count').notNull(),
    /** Set at plan completion; the retention worker deletes the thread after this. */
    retentionDeleteAfter: timestamp('retention_delete_after', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    ulidFormatCheck('message_thread_id_ulid_chk', t.id),
    ulidFormatCheck('message_thread_plan_id_ulid_chk', t.planId),
    // One thread per plan (unique; was a plain index in 0000, swapped in 0012).
    uniqueIndex('message_thread_plan_uq').on(t.planId),
  ],
);
