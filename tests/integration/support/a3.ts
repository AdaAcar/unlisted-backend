import { ulid } from 'ulidx';

import type { UserActor } from '@/db/scope/actor';

import type { TestDb } from './db';

export interface PlanFixture {
  actor: UserActor;
  host: UserActor;
  actorId: string;
  hostId: string;
  circleId: string;
  planId: string;
  venueId: string;
}

export function userActor(id: string, standing: UserActor['standing'] = 'good'): UserActor {
  return {
    kind: 'user',
    id,
    verificationState: 'verified',
    standing,
  };
}

export async function seedPublishedPlan(t: TestDb): Promise<PlanFixture> {
  const actorId = ulid();
  const hostId = ulid();
  const circleId = ulid();
  const circleMemberId = ulid();
  const venueId = ulid();
  const planId = ulid();

  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state)
     VALUES ($1, 'Actor', 'verified'), ($2, 'Host', 'verified')`,
    [actorId, hostId],
  );
  await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'Hosts', $2)`, [
    circleId,
    hostId,
  ]);
  await t.pool.query(
    `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
     VALUES ($1, $2, $3, 'lead', 'active', now())`,
    [circleMemberId, circleId, hostId],
  );
  await t.pool.query(
    `INSERT INTO venue (id, name, address, district, type)
     VALUES ($1, 'Venue', 'Public address', 'Kadikoy', 'bar')`,
    [venueId],
  );
  await t.pool.query(
    `INSERT INTO plan (
       id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
       district, venue_type, state, mode, published_at, confirmed_host_count
     ) VALUES ($1, $2, $3, now() + interval '2 days', 2, 1,
               'Kadikoy', 'bar', 'published', 'planned', now(), 1)`,
    [planId, circleId, venueId],
  );

  return {
    actor: userActor(actorId),
    host: userActor(hostId),
    actorId,
    hostId,
    circleId,
    planId,
    venueId,
  };
}

export function requiredTestUrl(name: 'APP_DATABASE_URL' | 'ADMIN_DATABASE_URL'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for A3 integration tests`);
  return value;
}
