import { sql, type SQL } from 'drizzle-orm';

import type { Actor } from '@/db/scope/actor';
import { scopedSelect, type ScopedQuery } from '@/db/scope/scoped';
import { blockPredicate, enforcementPredicate, visibilitySpecs } from '@/db/scope/visibility';

/**
 * Actor-scoped circle reads (C1). Same shape as `plans` / `users`: `sql`
 * fragments handed to `scopedSelect`, which applies the visibility spec and
 * runs the statement inside `withActor` — raw execution never happens here.
 *
 * `CircleRecord` deliberately omits `circle`'s record counters
 * (`plans_hosted`, `plans_attended`, `no_shows`, `late_declines`) and
 * `created_at`: no C1 audience needs them, and `no_shows` / `late_declines`
 * are signal-category fields that stay out of view models (docs/state.md
 * Decisions C1). F1 adds per-audience circle views and extends this record
 * if a moderator view ever needs the counters.
 */

export type CircleMemberStatus = 'invited' | 'active' | 'removed';
export type CircleRole = 'lead' | 'member';

export interface CircleRecord {
  id: string;
  name: string;
  leadUserId: string;
  /** Active members only, with blocked / enforcement-hidden co-members removed in SQL. */
  memberIds: string[];
}

export interface CircleMembershipFacts {
  membershipStatus: CircleMemberStatus | null;
  actorRole: CircleRole | null;
}

interface RawCircleRow {
  id: string;
  name: string;
  leadUserId: string;
  memberIds: string[] | null;
}

/**
 * The active-member id list as a correlated subquery, so block and
 * enforcement filters run inside the query (agent-rules section 3) rather
 * than over a fetched array. System actors never reach a circle read (the
 * spec denies them), so the user-id branch is unconditional here.
 */
function memberIdsSubquery(actor: Actor): SQL {
  if (actor.kind !== 'user') return sql`ARRAY[]::varchar[]`;
  const actorId = actor.id;
  return sql`COALESCE((
    SELECT array_agg(member_row.user_id ORDER BY member_row.joined_at, member_row.user_id)
    FROM circle_member member_row
    JOIN "user" member_user ON member_user.id = member_row.user_id
    WHERE member_row.circle_id = scoped_circle.id
      AND member_row.status = 'active'
      AND ${blockPredicate(actorId, sql`member_row.user_id`)}
      AND ${enforcementPredicate(actorId, sql`member_row.user_id`, sql`member_user.standing`)}
  ), ARRAY[]::varchar[])`;
}

function get(actor: Actor, id: string): ScopedQuery<CircleRecord | undefined> {
  return scopedSelect<RawCircleRow, CircleRecord | undefined>({
    actor,
    businessPredicates: [sql`scoped_circle.id = ${id}`],
    decode: (rows) => {
      const row = rows[0];
      return row ? { ...row, memberIds: row.memberIds ?? [] } : undefined;
    },
    selection: sql`
      scoped_circle.id AS "id",
      scoped_circle.name AS "name",
      scoped_circle.lead_user_id AS "leadUserId",
      ${memberIdsSubquery(actor)} AS "memberIds"`,
    spec: visibilitySpecs.circle,
    tail: sql`LIMIT 1`,
  });
}

/**
 * The actor's own relationship to a circle, for the policy layer. Prefers a
 * live (`invited` / `active`) row over a stale `removed` one, so a user who
 * was removed and re-invited reads as `invited`. Returns nulls when the
 * actor has no row at all — the caller turns that into a 404.
 */
function membershipFacts(actor: Actor, id: string): ScopedQuery<CircleMembershipFacts> {
  return scopedSelect<{ status: CircleMemberStatus; role: CircleRole }, CircleMembershipFacts>({
    actor,
    businessPredicates: [
      sql`scoped_circle_member.circle_id = ${id}`,
      actor.kind === 'user' ? sql`scoped_circle_member.user_id = ${actor.id}` : sql`FALSE`,
    ],
    decode: (rows) => {
      const row = rows[0];
      return {
        membershipStatus: row?.status ?? null,
        actorRole: row?.role ?? null,
      };
    },
    selection: sql`scoped_circle_member.status AS "status", scoped_circle_member.role AS "role"`,
    spec: visibilitySpecs.circleMember,
    tail: sql`ORDER BY (scoped_circle_member.status <> 'removed') DESC,
              scoped_circle_member.invited_at DESC
              LIMIT 1`,
  });
}

export const circles = { get, membershipFacts };
