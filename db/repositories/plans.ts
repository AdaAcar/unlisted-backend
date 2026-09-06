import { sql, type SQL } from 'drizzle-orm';

import type { Actor } from '@/db/scope/actor';
import { scopedSelect, type ScopedQuery } from '@/db/scope/scoped';
import { visibilitySpecs } from '@/db/scope/visibility';

/**
 * Discovery pagination bounds (C4). Not in `lib/config.ts`: those are the
 * agent-rules section-5 product parameters, pinned by `bootstrap.test.ts` — a
 * page cap is an API/enumeration knob, so it lives with its caller, the same
 * way B1 kept `SESSION_TTL_SECONDS` out of config.
 */
export const FEED_PAGE_DEFAULT = 25;
export const FEED_PAGE_MAX = 50;

/**
 * Keyset position over the feed's stable `(starts_at, id)` order. Just the plan
 * id: `feed` resolves the row's `(starts_at, id)` pair with a subquery against
 * the DB's own stored value, so the boundary is exact — no sub-millisecond
 * truncation from round-tripping a timestamp through JSON, which would let a
 * client re-see the row it just paged past.
 */
export interface FeedCursor {
  id: string;
}

export interface PlanFeedFilters {
  district?: string;
  startsAfter?: Date;
  startsBefore?: Date;
  venueType?: VenueType;
  cursor?: FeedCursor;
  /** Clamped to [1, FEED_PAGE_MAX]; defaults to FEED_PAGE_DEFAULT. */
  limit?: number;
}

type VenueType = 'bar' | 'restaurant' | 'club' | 'beach' | 'cafe';

export interface PlanRecord {
  id: string;
  hostCircleId: string;
  venueId: string;
  startsAt: Date;
  endsAt: Date | null;
  openSpots: number;
  minGroupSize: number;
  note: string | null;
  district: string;
  venueType: VenueType;
  state: 'draft' | 'published' | 'applications_closed' | 'completed' | 'cancelled';
  mode: 'planned' | 'tonight' | null;
  viableAt: Date | null;
  applicationsClosedAt: Date | null;
  cancellationKind: 'host' | 'non_viable' | null;
  confirmedHostCount: number;
  acceptedGuestCount: number;
  heldCount: number;
}

type RawPlanRecord = Omit<
  PlanRecord,
  'startsAt' | 'endsAt' | 'viableAt' | 'applicationsClosedAt'
> & {
  startsAt: Date | string;
  endsAt: Date | string | null;
  viableAt: Date | string | null;
  applicationsClosedAt: Date | string | null;
};

function timestamp(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function nullableTimestamp(value: Date | string | null): Date | null {
  return value === null ? null : timestamp(value);
}

function decodePlan(row: RawPlanRecord): PlanRecord {
  return {
    ...row,
    startsAt: timestamp(row.startsAt),
    endsAt: nullableTimestamp(row.endsAt),
    viableAt: nullableTimestamp(row.viableAt),
    applicationsClosedAt: nullableTimestamp(row.applicationsClosedAt),
  };
}

const selection = sql`
  scoped_plan.id AS "id",
  scoped_plan.host_circle_id AS "hostCircleId",
  scoped_plan.venue_id AS "venueId",
  scoped_plan.starts_at AS "startsAt",
  scoped_plan.ends_at AS "endsAt",
  scoped_plan.open_spots AS "openSpots",
  scoped_plan.min_group_size AS "minGroupSize",
  scoped_plan.note AS "note",
  scoped_plan.district AS "district",
  scoped_plan.venue_type AS "venueType",
  scoped_plan.state AS "state",
  scoped_plan.mode AS "mode",
  scoped_plan.viable_at AS "viableAt",
  scoped_plan.applications_closed_at AS "applicationsClosedAt",
  scoped_plan.cancellation_kind AS "cancellationKind",
  scoped_plan.confirmed_host_count AS "confirmedHostCount",
  scoped_plan.accepted_guest_count AS "acceptedGuestCount",
  scoped_plan.held_count AS "heldCount"`;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return FEED_PAGE_DEFAULT;
  return Math.min(FEED_PAGE_MAX, Math.max(1, Math.trunc(limit)));
}

function feed(actor: Actor, filters: PlanFeedFilters): ScopedQuery<PlanRecord[]> {
  const predicates: SQL[] = [sql`scoped_plan.state = 'published'`, sql`scoped_plan.open_spots > 0`];
  if (filters.district) predicates.push(sql`scoped_plan.district = ${filters.district}`);
  if (filters.startsAfter) predicates.push(sql`scoped_plan.starts_at >= ${filters.startsAfter}`);
  if (filters.startsBefore) predicates.push(sql`scoped_plan.starts_at < ${filters.startsBefore}`);
  if (filters.venueType) predicates.push(sql`scoped_plan.venue_type = ${filters.venueType}`);
  if (filters.cursor) {
    // Row-value keyset over the ORDER BY below. The boundary pair comes from the
    // DB's own row (subquery), not from the client, so a client can only advance
    // the scan, never widen the result — every page still re-applies the
    // visibility spec and the business predicates independently, and an
    // unknown / unseeable cursor id yields NULL here and an empty page.
    predicates.push(
      sql`(scoped_plan.starts_at, scoped_plan.id) >
          (SELECT cursor_plan.starts_at, cursor_plan.id
             FROM plan cursor_plan WHERE cursor_plan.id = ${filters.cursor.id})`,
    );
  }

  return scopedSelect<RawPlanRecord, PlanRecord[]>({
    actor,
    businessPredicates: predicates,
    decode: (rows) => rows.map(decodePlan),
    selection,
    spec: visibilitySpecs.plan,
    tail: sql`ORDER BY scoped_plan.starts_at, scoped_plan.id LIMIT ${clampLimit(filters.limit)}`,
  });
}

function get(actor: Actor, id: string): ScopedQuery<PlanRecord | undefined> {
  const publication =
    actor.kind === 'user'
      ? sql`(scoped_plan.published_at IS NOT NULL
             OR app_actor_hosts_circle(scoped_plan.host_circle_id))`
      : sql`scoped_plan.published_at IS NOT NULL`;
  return scopedSelect<RawPlanRecord, PlanRecord | undefined>({
    actor,
    businessPredicates: [sql`scoped_plan.id = ${id}`, publication],
    decode: (rows) => (rows[0] ? decodePlan(rows[0]) : undefined),
    selection,
    spec: visibilitySpecs.plan,
    tail: sql`LIMIT 1`,
  });
}

export const plans = { feed, get };
