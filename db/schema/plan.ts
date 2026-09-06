import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

import { timestamps, ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { modeEnum, planCancellationKindEnum, planStateEnum, venueTypeEnum } from './enums';
import { circle } from './circle';
import { venue } from './venue';

/**
 * A concrete outing at a venue with open spots.
 *
 * Mode and viability (docs/modes.md):
 *
 * - `mode` is derived at publish from `starts_at - now` against
 *   `SPONTANEOUS_THRESHOLD_H`, then stored and immutable. Immutability and the
 *   monotonic latch on `viable_at` are enforced by a trigger in
 *   0001_guards.sql.
 * - Viability is stored as two denormalised counters plus a first-crossing
 *   timestamp. `viable_at` LATCHES: it is set the first time
 *   `confirmed_total >= MIN_PLAN_TOTAL` and is never cleared. It means
 *   "introduction has occurred" — the thread and mutual visibility that follow
 *   are not undone by a later withdrawal.
 * - Whether the plan PROCEEDS is a separate, live question: at `starts_at`, if
 *   `confirmed_total < MIN_PLAN_TOTAL` the plan auto-cancels regardless of
 *   `viable_at`. See docs/state.md section 10.
 * - `held_count` tracks planned-mode invitation soft-holds. The capacity ceiling
 *   is `accepted_guest_count + held_count <= open_spots`, so an over-invitation
 *   cannot let two applicants accept the same spot.
 *
 * `confirmed_total` is a stored generated column. `viable_plan_key` (the FK
 * target that makes "no thread on a non-viable plan" structural) is added in
 * 0001_guards.sql.
 */
export const plan = pgTable(
  'plan',
  {
    id: ulidPrimaryKey(),
    hostCircleId: ulidColumn('host_circle_id')
      .notNull()
      .references(() => circle.id, { onDelete: 'restrict' }),
    venueId: ulidColumn('venue_id')
      .notNull()
      .references(() => venue.id, { onDelete: 'restrict' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    openSpots: integer('open_spots').notNull(),
    minGroupSize: integer('min_group_size').notNull(),
    note: text('note'),
    /** Denormalised from the venue for the discovery query (docs/data-model.md). */
    district: varchar('district', { length: 80 }).notNull(),
    /** Denormalised from the venue so discovery can filter by type without a join. */
    venueType: venueTypeEnum('venue_type').notNull(),
    state: planStateEnum('state').notNull().default('draft'),
    /** Null while draft; set at publish; immutable thereafter (trigger). */
    mode: modeEnum('mode'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationKind: planCancellationKindEnum('cancellation_kind'),
    /** Set by the earliest of: spots filled, host closes, starts_at (docs/modes.md). */
    applicationsClosedAt: timestamp('applications_closed_at', { withTimezone: true }),
    /** First-crossing timestamp. Latches; never cleared. */
    viableAt: timestamp('viable_at', { withTimezone: true }),
    confirmedHostCount: integer('confirmed_host_count').notNull().default(0),
    acceptedGuestCount: integer('accepted_guest_count').notNull().default(0),
    heldCount: integer('held_count').notNull().default(0),
    confirmedTotal: integer('confirmed_total').generatedAlwaysAs(
      sql`confirmed_host_count + accepted_guest_count`,
    ),
    ...timestamps,
  },
  (t) => [
    ulidFormatCheck('plan_id_ulid_chk', t.id),
    check('plan_open_spots_nonneg_chk', sql`${t.openSpots} >= 0`),
    check('plan_min_group_size_chk', sql`${t.minGroupSize} >= 1`),
    check('plan_ends_after_starts_chk', sql`${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`),
    // Relaxed by 0011_plan_write.sql: a plan cancelled before it was ever
    // published legitimately has no `mode` (docs/state.md Decisions C3). Every
    // other non-draft state is only reachable via publish, which sets `mode`.
    check(
      'plan_mode_set_after_draft_chk',
      sql`${t.state} IN ('draft', 'cancelled') OR ${t.mode} IS NOT NULL`,
    ),
    check('plan_confirmed_host_nonneg_chk', sql`${t.confirmedHostCount} >= 0`),
    check('plan_accepted_guest_nonneg_chk', sql`${t.acceptedGuestCount} >= 0`),
    check('plan_held_nonneg_chk', sql`${t.heldCount} >= 0`),
    // Capacity ceiling: accepted + held may never exceed open spots.
    check(
      'plan_capacity_ceiling_chk',
      sql`${t.acceptedGuestCount} + ${t.heldCount} <= ${t.openSpots}`,
    ),
    check(
      'plan_cancellation_kind_chk',
      sql`${t.state} = 'cancelled' OR ${t.cancellationKind} IS NULL`,
    ),
    index('plan_discovery_idx').on(t.district, t.state, t.startsAt),
    index('plan_host_circle_idx').on(t.hostCircleId),
    index('plan_venue_idx').on(t.venueId),
  ],
);
