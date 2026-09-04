import { pgTable, timestamp, unique } from 'drizzle-orm/pg-core';

import { ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { user } from './user';

/**
 * Immutable evidence that two people were introduced through a viable plan.
 *
 * This is not plan membership, thread membership, grouping, or capacity state.
 * The FK from `plan_id` to the custom `plan.viable_plan_key` column and the
 * append-only triggers are installed in 0004_a3_corrections.sql because
 * Drizzle does not model that generated-column target.
 */
export const planParticipantIntroduction = pgTable(
  'plan_participant_introduction',
  {
    id: ulidPrimaryKey(),
    planId: ulidColumn('plan_id').notNull(),
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    introducedAt: timestamp('introduced_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    ulidFormatCheck('plan_participant_introduction_id_ulid_chk', t.id),
    unique('plan_participant_introduction_plan_user_uq').on(t.planId, t.userId),
  ],
);
