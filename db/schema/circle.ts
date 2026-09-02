import { sql } from 'drizzle-orm';
import { check, integer, pgTable, varchar } from 'drizzle-orm/pg-core';

import { timestamps, ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { user } from './user';

/**
 * A persistent group that goes out together. Has a lead and members, and accrues
 * its own record. Membership changes are logged (see `circle_member`).
 *
 * `lead_user_id` should always correspond to a `circle_member` row with
 * `role = 'lead'` and `status = 'active'`; that cross-row consistency is a domain
 * invariant, not a database constraint (see CLAUDE.md section 11).
 */
export const circle = pgTable(
  'circle',
  {
    id: ulidPrimaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    leadUserId: ulidColumn('lead_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    // Circle-level record, inlined as counters (docs/data-model.md treats it as a field).
    plansHosted: integer('plans_hosted').notNull().default(0),
    plansAttended: integer('plans_attended').notNull().default(0),
    noShows: integer('no_shows').notNull().default(0),
    lateDeclines: integer('late_declines').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    ulidFormatCheck('circle_id_ulid_chk', t.id),
    check(
      'circle_record_nonneg_chk',
      sql`${t.plansHosted} >= 0 AND ${t.plansAttended} >= 0 AND ${t.noShows} >= 0
          AND ${t.lateDeclines} >= 0`,
    ),
  ],
);
