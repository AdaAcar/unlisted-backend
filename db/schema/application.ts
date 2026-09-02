import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { timestamps, ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { applicationStateEnum, modeEnum } from './enums';
import { circle } from './circle';
import { plan } from './plan';
import { user } from './user';

/**
 * A request to join a plan, from a circle or a solo applicant. `mode` is
 * denormalised from the plan and fixes which state set is legal (docs/modes.md):
 *
 * - planned: draft -> awaiting_confirmation -> submitted -> shortlisted ->
 *   invited -> accepted | declined | expired, or -> rejected, or -> withdrawn.
 * - tonight: submitted -> approved | rejected | withdrawn | expired.
 *
 * `response_deadline` exists in planned mode only.
 */
export const application = pgTable(
  'application',
  {
    id: ulidPrimaryKey(),
    planId: ulidColumn('plan_id')
      .notNull()
      .references(() => plan.id, { onDelete: 'restrict' }),
    applicantCircleId: ulidColumn('applicant_circle_id').references(() => circle.id, {
      onDelete: 'restrict',
    }),
    soloUserId: ulidColumn('solo_user_id').references(() => user.id, { onDelete: 'restrict' }),
    mode: modeEnum('mode').notNull(),
    state: applicationStateEnum('state').notNull(),
    note: text('note'),
    responseDeadline: timestamp('response_deadline', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    ulidFormatCheck('application_id_ulid_chk', t.id),
    // Exactly one of circle / solo.
    check(
      'application_circle_xor_solo_chk',
      sql`(${t.applicantCircleId} IS NULL) <> (${t.soloUserId} IS NULL)`,
    ),
    check(
      'application_response_deadline_mode_chk',
      sql`${t.mode} = 'planned' OR ${t.responseDeadline} IS NULL`,
    ),
    // The legal state set depends on the mode.
    check(
      'application_state_by_mode_chk',
      sql`(${t.mode} = 'planned' AND ${t.state} IN (
            'draft', 'awaiting_confirmation', 'submitted', 'shortlisted', 'invited',
            'accepted', 'declined', 'expired', 'rejected', 'withdrawn'
          ))
          OR (${t.mode} = 'tonight' AND ${t.state} IN (
            'submitted', 'approved', 'rejected', 'withdrawn', 'expired'
          ))`,
    ),
    index('application_plan_idx').on(t.planId, t.state),
    index('application_applicant_circle_idx').on(t.applicantCircleId),
    index('application_solo_user_idx').on(t.soloUserId),
  ],
);
