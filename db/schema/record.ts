import { sql } from 'drizzle-orm';
import { check, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

import { timestamps, ulidColumn } from './_helpers';
import { user } from './user';

/**
 * Platform-generated attendance record for a user. Not user-editable. Visible to
 * a host circle lead reviewing an application; never in any browse context,
 * because there is no browse context for people (docs/data-model.md).
 *
 * One row per user: the primary key is the user reference.
 */
export const record = pgTable(
  'record',
  {
    userId: ulidColumn('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'restrict' }),
    plansAttended: integer('plans_attended').notNull().default(0),
    noShows: integer('no_shows').notNull().default(0),
    lateDeclines: integer('late_declines').notNull().default(0),
    repeatInvitations: integer('repeat_invitations').notNull().default(0),
    circlesLed: integer('circles_led').notNull().default(0),
    firstPlanAt: timestamp('first_plan_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check(
      'record_counts_nonneg_chk',
      sql`${t.plansAttended} >= 0 AND ${t.noShows} >= 0 AND ${t.lateDeclines} >= 0
          AND ${t.repeatInvitations} >= 0 AND ${t.circlesLed} >= 0`,
    ),
  ],
);
