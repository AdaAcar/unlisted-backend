import { sql } from 'drizzle-orm';
import { ulid } from 'ulidx';

import type { Ulid, UserActor } from '@/db/scope/actor';
import type { ActorTransaction } from '@/db/scope/scoped';

/**
 * Session write path (B1, todo_agent.md). Takes the caller's already-open
 * `withActor` executor and never opens its own transaction — mirroring
 * `db/audit.ts` — so a session write and the audit entry recorded alongside
 * it (same caller, same transaction) commit or roll back together.
 *
 * Every function filters on the given actor's own id in the query itself,
 * not only via the `session_app_insert`/`session_app_delete` RLS policies
 * (migration 0007) — defense in depth, the same shape as `db/audit.ts`
 * deriving `actor_id` from `actor` rather than trusting a caller-supplied
 * field.
 */

export async function createSession(
  executor: ActorTransaction,
  actor: UserActor,
  tokenHash: string,
  expiresAt: Date,
): Promise<Ulid> {
  const id = ulid();
  await executor.execute(sql`
    INSERT INTO session (id, user_id, token_hash, expires_at)
    VALUES (${id}, ${actor.id}, ${tokenHash}, ${expiresAt.toISOString()})
  `);
  return id;
}

/** Returns whether a matching session row actually existed to delete. */
export async function deleteSessionByTokenHash(
  executor: ActorTransaction,
  actor: UserActor,
  tokenHash: string,
): Promise<boolean> {
  const result = await executor.execute(
    sql`DELETE FROM session WHERE user_id = ${actor.id} AND token_hash = ${tokenHash}`,
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Rotation on privilege change: the prior identifier stops working and a new
 * one takes over, both under the caller's one transaction. Delete-then-insert
 * rather than an in-place UPDATE — see the module comment above for why
 * `unlisted_app`'s migration 0007 grant has no UPDATE at all.
 */
export async function rotateSession(
  executor: ActorTransaction,
  actor: UserActor,
  oldTokenHash: string,
  newTokenHash: string,
  expiresAt: Date,
): Promise<Ulid> {
  await deleteSessionByTokenHash(executor, actor, oldTokenHash);
  return createSession(executor, actor, newTokenHash, expiresAt);
}
