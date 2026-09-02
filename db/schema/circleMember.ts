import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { timestamps, ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { circleMemberRoleEnum, circleMemberStatusEnum } from './enums';
import { circle } from './circle';
import { user } from './user';

/**
 * Circle membership, with lifecycle: `invited` -> `active`, or `removed`.
 * A user may be re-invited to a circle they previously left, so uniqueness of
 * (circle, user) is enforced only over rows that are not `removed`.
 */
export const circleMember = pgTable(
  'circle_member',
  {
    id: ulidPrimaryKey(),
    circleId: ulidColumn('circle_id')
      .notNull()
      .references(() => circle.id, { onDelete: 'restrict' }),
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    role: circleMemberRoleEnum('role').notNull().default('member'),
    status: circleMemberStatusEnum('status').notNull().default('invited'),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    ulidFormatCheck('circle_member_id_ulid_chk', t.id),
    uniqueIndex('circle_member_active_uq')
      .on(t.circleId, t.userId)
      .where(sql`${t.status} <> 'removed'`),
    index('circle_member_user_idx').on(t.userId),
    index('circle_member_circle_idx').on(t.circleId),
  ],
);
