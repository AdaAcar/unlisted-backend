import { sql } from 'drizzle-orm';
import { ulid } from 'ulidx';

import type { Ulid, UserActor } from '@/db/scope/actor';
import type { ActorTransaction } from '@/db/scope/scoped';

/**
 * Circle write path (C1). Takes the caller's already-open `withActor`
 * executor and never opens its own transaction — mirroring `db/session.ts`
 * and `db/audit.ts` — so each circle write and the audit entry the route
 * records alongside it commit or roll back together.
 *
 * No authorization lives here: the route calls `policy()` first. These
 * functions still return typed outcomes ("not a member", "lead must
 * transfer") the route maps to status codes; and migration 0009's RLS is a
 * backstop on every statement. The one source of truth for "who leads this
 * circle" is `circle_member(role='lead', status='active')` (never
 * `circle.lead_user_id`), kept single-valued by the `circle_one_active_lead`
 * partial unique index.
 */

export interface CreatedCircle {
  id: Ulid;
  name: string;
  leadUserId: Ulid;
}

/** `POST /circles`: the circle row and the creator's lead membership, one transaction. */
export async function createCircle(
  executor: ActorTransaction,
  actor: UserActor,
  name: string,
): Promise<CreatedCircle> {
  const id = ulid();
  await executor.execute(
    sql`INSERT INTO circle (id, name, lead_user_id) VALUES (${id}, ${name}, ${actor.id})`,
  );
  await executor.execute(sql`
    INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
    VALUES (${ulid()}, ${id}, ${actor.id}, 'lead', 'active', now())
  `);
  return { id, name, leadUserId: actor.id };
}

export type InviteMemberResult = 'invited' | 'unknown_user' | 'already_member';

/** `POST /circles/:id/members`: lead invites a user; the invitee must accept separately. */
export async function inviteMember(
  executor: ActorTransaction,
  circleId: Ulid,
  inviteeUserId: Ulid,
): Promise<InviteMemberResult> {
  try {
    await executor.execute(sql`
      INSERT INTO circle_member (id, circle_id, user_id, role, status)
      VALUES (${ulid()}, ${circleId}, ${inviteeUserId}, 'member', 'invited')
    `);
    return 'invited';
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '23503') return 'unknown_user'; // FK: no such user
    if (code === '23505') return 'already_member'; // circle_member_active_uq
    throw error;
  }
}

/** `POST /circles/:id/members/accept`: the invitee's own action. Idempotent-safe: 0 rows if not pending. */
export async function acceptCircleInvitation(
  executor: ActorTransaction,
  actor: UserActor,
  circleId: Ulid,
): Promise<boolean> {
  const result = await executor.execute(sql`
    UPDATE circle_member SET status = 'active', joined_at = now()
    WHERE circle_id = ${circleId} AND user_id = ${actor.id} AND status = 'invited'
  `);
  return (result.rowCount ?? 0) > 0;
}

export type RemoveMemberResult = 'removed' | 'not_a_member' | 'lead_must_transfer';

/**
 * `DELETE /circles/:id/members/:userId`: the lead removes anyone, or a member
 * removes themselves (an invited member removing their own row is how a
 * pending invitation is declined). Soft: `status = 'removed'`. The sitting
 * lead cannot remove themselves while leading — the circle would have no
 * lead and no one able to act — they must transfer first.
 */
export async function removeCircleMember(
  executor: ActorTransaction,
  actor: UserActor,
  circleId: Ulid,
  targetUserId: Ulid,
  actorIsLead: boolean,
): Promise<RemoveMemberResult> {
  if (actorIsLead && targetUserId === actor.id) return 'lead_must_transfer';
  const result = await executor.execute(sql`
    UPDATE circle_member SET status = 'removed', removed_at = now()
    WHERE circle_id = ${circleId} AND user_id = ${targetUserId} AND status <> 'removed'
  `);
  return (result.rowCount ?? 0) > 0 ? 'removed' : 'not_a_member';
}

export type TransferLeadResult = 'transferred' | 'noop_same_lead' | 'not_a_member';

/**
 * `POST /circles/:id/lead`: the current lead hands the role to another active
 * member. Locks the circle row, then moves `circle.lead_user_id` and swaps
 * the two role rows in a single statement so `circle_one_active_lead` never
 * sees zero or two active leads.
 */
export async function transferCircleLead(
  executor: ActorTransaction,
  actor: UserActor,
  circleId: Ulid,
  newLeadUserId: Ulid,
): Promise<TransferLeadResult> {
  await executor.execute(sql`SELECT id FROM circle WHERE id = ${circleId} FOR UPDATE`);

  if (newLeadUserId === actor.id) return 'noop_same_lead';

  const active = await executor.execute(sql`
    SELECT 1 FROM circle_member
    WHERE circle_id = ${circleId} AND user_id = ${newLeadUserId} AND status = 'active'
  `);
  if ((active.rowCount ?? 0) === 0) return 'not_a_member';

  await executor.execute(
    sql`UPDATE circle SET lead_user_id = ${newLeadUserId} WHERE id = ${circleId}`,
  );
  await executor.execute(sql`
    UPDATE circle_member
    SET role = CASE
      WHEN user_id = ${actor.id} THEN 'member'::circle_member_role
      WHEN user_id = ${newLeadUserId} THEN 'lead'::circle_member_role
    END
    WHERE circle_id = ${circleId}
      AND user_id IN (${actor.id}, ${newLeadUserId})
      AND status = 'active'
  `);
  return 'transferred';
}
