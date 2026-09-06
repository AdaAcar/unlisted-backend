import { sql, type SQL } from 'drizzle-orm';

import { venueTypeEnum } from '@/db/schema';
import type { Actor } from '@/db/scope/actor';
import { withActor } from '@/db/scope/scoped';

/**
 * The venue registry read path (C2).
 *
 * Unlike `plans` / `users` / `circles`, this repository does **not** go
 * through `scopedSelect` and has no `VisibilitySpec`. That chokepoint exists
 * to auto-apply block + enforcement visibility against a counterparty user,
 * and a venue has none — it is public infrastructure, the same rows for every
 * authenticated actor (docs/data-model.md; docs/state.md Decisions C2). So it
 * opens `withActor` directly (needed only to activate `unlisted_app` and the
 * actor GUC that migration 0010's `venue_app_read` policy checks) and runs a
 * plain `SELECT`. **This shape is correct here and wrong for every social
 * table** — do not copy it onto one; those must route through `scopedSelect`.
 *
 * The `SELECT` lists only the six public columns; migration 0010 grants
 * `unlisted_app` SELECT on exactly those, so `licence_ref` / `capacity_hint`
 * cannot be read here even by mistake.
 */

export const VENUE_TYPES = venueTypeEnum.enumValues;
export type VenueType = (typeof VENUE_TYPES)[number];

export interface VenueRecord {
  id: string;
  name: string;
  address: string;
  district: string;
  type: VenueType;
  operatorVerified: boolean;
}

export interface VenueFilters {
  district?: string;
  type?: VenueType;
}

const SELECTION = sql`
  id,
  name,
  address,
  district,
  type,
  operator_verified AS "operatorVerified"`;

export async function listVenues(actor: Actor, filters: VenueFilters): Promise<VenueRecord[]> {
  const predicates: SQL[] = [];
  if (filters.district !== undefined) predicates.push(sql`district = ${filters.district}`);
  if (filters.type !== undefined) predicates.push(sql`type = ${filters.type}`);
  const where = predicates.length === 0 ? sql`` : sql` WHERE ${sql.join(predicates, sql` AND `)}`;

  return withActor(actor, async (executor) => {
    const result = await executor.execute(
      sql`SELECT ${SELECTION} FROM venue${where} ORDER BY district, name, id`,
    );
    return result.rows as unknown as VenueRecord[];
  });
}

export async function getVenue(actor: Actor, id: string): Promise<VenueRecord | undefined> {
  return withActor(actor, async (executor) => {
    const result = await executor.execute(
      sql`SELECT ${SELECTION} FROM venue WHERE id = ${id} LIMIT 1`,
    );
    return (result.rows as unknown as VenueRecord[])[0];
  });
}

export const venues = { list: listVenues, get: getVenue };
