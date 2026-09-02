import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, timestamp } from 'drizzle-orm/pg-core';

import { ulidColumn } from './_helpers';
import { user } from './user';

/**
 * A directed block edge. The filter is bidirectional and applied inside the
 * repository query (A3), never after fetching and never in the UI: neither party
 * sees the other's plans, applications, or profile, and neither is told
 * (docs/data-model.md, docs/security.md).
 *
 * This table only stores the edge. No `updated_at`: a block is not edited.
 */
export const block = pgTable(
  'block',
  {
    blockerUserId: ulidColumn('blocker_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    blockedUserId: ulidColumn('blocked_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerUserId, t.blockedUserId] }),
    check('block_no_self_chk', sql`${t.blockerUserId} <> ${t.blockedUserId}`),
    index('block_blocked_idx').on(t.blockedUserId),
  ],
);
