import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { timestamps, ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import {
  applicationMemberConfirmationStateEnum,
  applicationMemberInvitationStateEnum,
} from './enums';
import { application } from './application';
import { user } from './user';

/**
 * Per-member state within a circle application. Replaces the `member_states[]`
 * array in docs/data-model.md.
 *
 * Rows exist for circle applications: in planned mode, one per included member;
 * in tonight mode, only the lead (other members apply as their own
 * applications). Solo applications have no rows — `application.solo_user_id` is
 * the participant.
 *
 * Planned mode binds a confirmation to a version hash of the application; a
 * confirmed row must carry that hash, and an unconfirmed one must not.
 */
export const applicationMember = pgTable(
  'application_member',
  {
    id: ulidPrimaryKey(),
    applicationId: ulidColumn('application_id')
      .notNull()
      .references(() => application.id, { onDelete: 'cascade' }),
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    confirmationState: applicationMemberConfirmationStateEnum('confirmation_state')
      .notNull()
      .default('unconfirmed'),
    confirmedVersionHash: text('confirmed_version_hash'),
    invitationState: applicationMemberInvitationStateEnum('invitation_state')
      .notNull()
      .default('not_invited'),
    /** Planned-mode invitation soft-hold expiry; released on decline or expiry. */
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    ulidFormatCheck('application_member_id_ulid_chk', t.id),
    uniqueIndex('application_member_app_user_uq').on(t.applicationId, t.userId),
    check(
      'application_member_confirmed_hash_chk',
      sql`(${t.confirmationState} = 'confirmed') = (${t.confirmedVersionHash} IS NOT NULL)`,
    ),
    index('application_member_user_idx').on(t.userId),
  ],
);
