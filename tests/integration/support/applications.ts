import { ulid } from 'ulidx';

import { generateSessionToken, hashSessionToken } from '@/lib/sessionToken';

import type { TestDb } from './db';

/**
 * Seeding helpers for the C5 / C6 / C7a application-flow tests. Rows are
 * inserted directly with the superuser pool (bypassing RLS) — the same shape
 * `support/a3.ts` uses — so a test starts from an arbitrary fixture without
 * driving every upstream route.
 */

export async function seedUser(
  t: TestDb,
  opts: { verified?: boolean; standing?: string; name?: string } = {},
): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state, standing) VALUES ($1, $2, $3, $4)`,
    [id, opts.name ?? 'U', opts.verified === false ? 'none' : 'verified', opts.standing ?? 'good'],
  );
  return id;
}

export async function cookieFor(t: TestDb, userId: string): Promise<string> {
  const token = generateSessionToken();
  await t.pool.query(
    `INSERT INTO session (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [ulid(), userId, hashSessionToken(token)],
  );
  return `session=${token}`;
}

export async function seedVenue(t: TestDb, district = 'Kadikoy'): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO venue (id, name, address, district, type) VALUES ($1, 'V', 'Public address', $2, 'bar')`,
    [id, district],
  );
  return id;
}

export interface CircleSeed {
  circleId: string;
  leadId: string;
  memberIds: string[];
}

/** A circle with an active lead and `extraMembers` more active members. */
export async function seedCircle(t: TestDb, extraMembers = 0): Promise<CircleSeed> {
  const leadId = await seedUser(t, { name: 'Lead' });
  const circleId = ulid();
  await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'C', $2)`, [
    circleId,
    leadId,
  ]);
  await t.pool.query(
    `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
     VALUES ($1, $2, $3, 'lead', 'active', now())`,
    [ulid(), circleId, leadId],
  );
  const memberIds = [leadId];
  for (let i = 0; i < extraMembers; i += 1) {
    const uid = await seedUser(t, { name: `M${i}` });
    await t.pool.query(
      `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'member', 'active', now())`,
      [ulid(), circleId, uid],
    );
    memberIds.push(uid);
  }
  return { circleId, leadId, memberIds };
}

export interface PlanSeed {
  planId: string;
  hostCircleId: string;
  hostLeadId: string;
  venueId: string;
}

export interface PlanOpts {
  mode?: 'planned' | 'tonight';
  openSpots?: number;
  minGroupSize?: number;
  /** Extra active members in the host circle beyond the lead. */
  hostExtraMembers?: number;
  confirmedHostCount?: number;
  startsInDays?: number;
  district?: string;
  state?: string;
}

/** A published plan with its host circle. `confirmed_host_count` defaults to the true host size. */
export async function seedPublishedPlan(t: TestDb, opts: PlanOpts = {}): Promise<PlanSeed> {
  const host = await seedCircle(t, opts.hostExtraMembers ?? 0);
  const venueId = await seedVenue(t, opts.district ?? 'Kadikoy');
  const planId = ulid();
  const mode = opts.mode ?? 'planned';
  const startsInDays = opts.startsInDays ?? 5;
  const confirmedHostCount = opts.confirmedHostCount ?? host.memberIds.length;
  await t.pool.query(
    `INSERT INTO plan (
       id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
       district, venue_type, state, mode, published_at, confirmed_host_count
     ) VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5, $6,
               $7, 'bar', $8, $9, now(), $10)`,
    [
      planId,
      host.circleId,
      venueId,
      String(startsInDays),
      opts.openSpots ?? 2,
      opts.minGroupSize ?? 1,
      opts.district ?? 'Kadikoy',
      opts.state ?? 'published',
      mode,
      confirmedHostCount,
    ],
  );
  return { planId, hostCircleId: host.circleId, hostLeadId: host.leadId, venueId };
}

export async function planRow(t: TestDb, id: string): Promise<Record<string, unknown>> {
  const { rows } = await t.pool.query(`SELECT * FROM plan WHERE id = $1`, [id]);
  return rows[0] as Record<string, unknown>;
}

export async function applicationRow(t: TestDb, id: string): Promise<Record<string, unknown>> {
  const { rows } = await t.pool.query(`SELECT * FROM application WHERE id = $1`, [id]);
  return rows[0] as Record<string, unknown>;
}

export async function memberRows(
  t: TestDb,
  applicationId: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await t.pool.query(
    `SELECT * FROM application_member WHERE application_id = $1 ORDER BY user_id`,
    [applicationId],
  );
  return rows as Record<string, unknown>[];
}

export async function introducedUserIds(t: TestDb, planId: string): Promise<string[]> {
  const { rows } = await t.pool.query<{ user_id: string }>(
    `SELECT user_id FROM plan_participant_introduction WHERE plan_id = $1 ORDER BY user_id`,
    [planId],
  );
  return rows.map((r) => r.user_id);
}

export const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
