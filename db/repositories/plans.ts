import { sql, type SQL } from 'drizzle-orm';

import type { Actor } from '@/db/scope/actor';
import { scopedSelect, type ScopedQuery } from '@/db/scope/scoped';
import { visibilitySpecs } from '@/db/scope/visibility';

export interface PlanFeedFilters {
  district?: string;
  startsAfter?: Date;
  startsBefore?: Date;
  venueType?: VenueType;
}

type VenueType = 'bar' | 'restaurant' | 'club' | 'beach' | 'cafe';

export interface PlanRecord {
  id: string;
  hostCircleId: string;
  venueId: string;
  startsAt: Date;
  openSpots: number;
  district: string;
  venueType: VenueType;
  state: 'draft' | 'published' | 'applications_closed' | 'completed' | 'cancelled';
  mode: 'planned' | 'tonight' | null;
  viableAt: Date | null;
  confirmedHostCount: number;
  acceptedGuestCount: number;
  heldCount: number;
}

type RawPlanRecord = Omit<PlanRecord, 'startsAt' | 'viableAt'> & {
  startsAt: Date | string;
  viableAt: Date | string | null;
};

function timestamp(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function decodePlan(row: RawPlanRecord): PlanRecord {
  return {
    ...row,
    startsAt: timestamp(row.startsAt),
    viableAt: row.viableAt === null ? null : timestamp(row.viableAt),
  };
}

const selection = sql`
  scoped_plan.id AS "id",
  scoped_plan.host_circle_id AS "hostCircleId",
  scoped_plan.venue_id AS "venueId",
  scoped_plan.starts_at AS "startsAt",
  scoped_plan.open_spots AS "openSpots",
  scoped_plan.district AS "district",
  scoped_plan.venue_type AS "venueType",
  scoped_plan.state AS "state",
  scoped_plan.mode AS "mode",
  scoped_plan.viable_at AS "viableAt",
  scoped_plan.confirmed_host_count AS "confirmedHostCount",
  scoped_plan.accepted_guest_count AS "acceptedGuestCount",
  scoped_plan.held_count AS "heldCount"`;

function feed(actor: Actor, filters: PlanFeedFilters): ScopedQuery<PlanRecord[]> {
  const predicates: SQL[] = [sql`scoped_plan.state = 'published'`, sql`scoped_plan.open_spots > 0`];
  if (filters.district) predicates.push(sql`scoped_plan.district = ${filters.district}`);
  if (filters.startsAfter) predicates.push(sql`scoped_plan.starts_at >= ${filters.startsAfter}`);
  if (filters.startsBefore) predicates.push(sql`scoped_plan.starts_at < ${filters.startsBefore}`);
  if (filters.venueType) predicates.push(sql`scoped_plan.venue_type = ${filters.venueType}`);

  return scopedSelect<RawPlanRecord, PlanRecord[]>({
    actor,
    businessPredicates: predicates,
    decode: (rows) => rows.map(decodePlan),
    selection,
    spec: visibilitySpecs.plan,
    tail: sql`ORDER BY scoped_plan.starts_at, scoped_plan.id`,
  });
}

function get(actor: Actor, id: string): ScopedQuery<PlanRecord | undefined> {
  return scopedSelect<RawPlanRecord, PlanRecord | undefined>({
    actor,
    businessPredicates: [sql`scoped_plan.id = ${id}`],
    decode: (rows) => (rows[0] ? decodePlan(rows[0]) : undefined),
    selection,
    spec: visibilitySpecs.plan,
    tail: sql`LIMIT 1`,
  });
}

export const plans = { feed, get };
