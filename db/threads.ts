import { sql } from 'drizzle-orm';
import { ulid } from 'ulidx';

import type { Ulid, UserActor } from '@/db/scope/actor';
import type { ActorTransaction } from '@/db/scope/scoped';

/**
 * Thread and message write path (C8). Takes the caller's already-open
 * `withActor` executor — mirrors `db/circles.ts` / `db/plans.ts` — so a write
 * and the audit entry the route records alongside it commit or roll back
 * together.
 *
 * `createThreadForViablePlan` has NO production caller yet: threads are created
 * on the viability crossing, which lands in C7c. C8 ships and tests the path
 * directly (same shape as A4's `recordAuditEntry` before B1, C3's
 * `completePlan` before E1). See docs/state.md Known gaps C8.
 *
 * No authorization logic here. Migration 0012's RLS is the enforcement:
 * `message_thread_app_insert` requires `app_thread_participant(plan_id)`, and
 * the FK to `plan.viable_plan_key` requires the plan to be viable — so a
 * non-participant or a non-viable plan surfaces as a typed outcome the route
 * maps to a status code.
 */

const RLS_VIOLATION = '42501';
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

export type CreateThreadOutcome =
  | { ok: true; id: Ulid }
  | { ok: false; reason: 'not_viable' | 'exists' | 'not_participant' };

/** One thread per viable plan; `participant_count` is trigger-filled from the ledger. */
export async function createThreadForViablePlan(
  executor: ActorTransaction,
  planId: Ulid,
): Promise<CreateThreadOutcome> {
  const id = ulid();
  try {
    await executor.execute(
      sql`INSERT INTO message_thread (id, plan_id, participant_count) VALUES (${id}, ${planId}, 0)`,
    );
    return { ok: true, id };
  } catch (error) {
    const code = (error as { code?: string }).code;
    // FK to plan.viable_plan_key has no target, or the ledger is short of the
    // >= 3 floor — both mean "this plan is not (yet) a viable plan with a real
    // introduced group".
    if (code === FK_VIOLATION || code === CHECK_VIOLATION)
      return { ok: false, reason: 'not_viable' };
    if (code === UNIQUE_VIOLATION) return { ok: false, reason: 'exists' };
    if (code === RLS_VIOLATION) return { ok: false, reason: 'not_participant' };
    throw error;
  }
}

export type PostMessageOutcome =
  | { ok: true; id: Ulid; createdAt: Date }
  | { ok: false; reason: 'no_thread' | 'not_participant' };

export async function postMessage(
  executor: ActorTransaction,
  actor: UserActor,
  threadId: Ulid,
  body: string,
): Promise<PostMessageOutcome> {
  const id = ulid();
  try {
    const result = await executor.execute(sql`
      INSERT INTO message (id, thread_id, sender_user_id, body)
      VALUES (${id}, ${threadId}, ${actor.id}, ${body})
      RETURNING created_at AS "createdAt"
    `);
    const row = result.rows[0] as { createdAt: Date | string };
    return {
      ok: true,
      id,
      createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === FK_VIOLATION) return { ok: false, reason: 'no_thread' };
    if (code === RLS_VIOLATION) return { ok: false, reason: 'not_participant' };
    throw error;
  }
}
