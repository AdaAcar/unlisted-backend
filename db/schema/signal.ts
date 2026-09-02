import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

import {
  ULID_PATTERN,
  softDelete,
  timestamps,
  ulidColumn,
  ulidFormatCheck,
  ulidPrimaryKey,
} from './_helpers';
import { signalKindEnum } from './enums';
import { plan } from './plan';
import { user } from './user';

/**
 * Any observation that feeds enforcement. A report is one kind; most are softer
 * and platform-generated (`reporter_user_id` null).
 *
 * Signals are never exposed to any user, including the subject — that is a view
 * model rule (phase D / F), not a database constraint. `case_id` links a signal
 * to a moderation case; the case table itself is D4.
 */
export const signal = pgTable(
  'signal',
  {
    id: ulidPrimaryKey(),
    subjectUserId: ulidColumn('subject_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    reporterUserId: ulidColumn('reporter_user_id').references(() => user.id, {
      onDelete: 'restrict',
    }),
    planId: ulidColumn('plan_id').references(() => plan.id, { onDelete: 'restrict' }),
    kind: signalKindEnum('kind').notNull(),
    weight: integer('weight').notNull(),
    caseId: ulidColumn('case_id'),
    /** Signals expire on a schedule unless part of an active case (retention). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    ulidFormatCheck('signal_id_ulid_chk', t.id),
    check(
      'signal_case_id_ulid_chk',
      sql`${t.caseId} IS NULL OR ${t.caseId} ~ ${sql.raw(`'${ULID_PATTERN}'`)}`,
    ),
    index('signal_subject_idx').on(t.subjectUserId),
    index('signal_case_idx').on(t.caseId),
  ],
);
