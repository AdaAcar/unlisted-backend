import { sql } from 'drizzle-orm';

import type { Ulid } from '@/db/scope/actor';
import type { ActorTransaction } from '@/db/scope/scoped';

/**
 * Verification write path (B2, todo_agent.md). Both functions take the
 * caller's already-open `withActor` executor and never open one of their
 * own — mirroring `db/audit.ts` and `db/session.ts` — so a verification
 * write and the audit entry recorded alongside it commit or roll back
 * together.
 *
 * Both run as a `SystemActor`: the webhook is vendor-authenticated (no
 * session, no user actor), and migration 0008's trigger
 * (`enforce_verification_columns_system_only`) rejects any change to these
 * four columns unless the transaction's actor GUC is system-labeled,
 * regardless of which caller invoked it. `startVerification` also runs as
 * system for the same reason, even though a real user's session request
 * triggers it.
 */

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * `POST /verification/start`: marks the user pending and records the
 * vendor's session ref. Caller must already be inside
 * `withActor(SYSTEM_ACTOR, ...)` — migration 0008's trigger rejects this
 * write otherwise, regardless of what this function does.
 */
export async function startVerification(
  executor: ActorTransaction,
  userId: Ulid,
  vendorSessionRef: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE "user"
    SET verification_state = 'pending', verification_ref = ${vendorSessionRef}
    WHERE id = ${userId}
  `);
}

export interface CompleteVerificationParams {
  vendorSessionRef: string;
  verificationState: 'verified' | 'failed';
  /** Ignored (existing value kept) unless `verificationState` is 'verified'. */
  age: number | null;
  /** Ignored (existing value kept) unless `verificationState` is 'verified'. */
  identityHash: string | null;
}

/**
 * `POST /verification/webhook`. Matches the row by `verification_ref` alone
 * (single-use, unique — `user_verification_ref_uq`) rather than requiring a
 * separate lookup step, so the match-and-write is one atomic statement.
 * `RETURNING id` hands back which user this was, for the caller's audit
 * entry, without a second query. Clears `verification_ref` unconditionally:
 * a vendor session is spent either way, verified or failed, and cannot be
 * replayed.
 *
 * `age`/`identity_hash` are only overwritten on a 'verified' outcome — a
 * 'failed' outcome (e.g. a re-verification attempt by an already-verified
 * user) must not wipe out a previously-verified user's existing values.
 *
 * Returns the matched user's id, or `null` if nothing matched. A caught
 * unique violation (identity_hash collision — `user_identity_hash_uq`) is
 * folded into the same `null` outcome as "no matching session": the caller
 * must not be able to distinguish a collision from a bad/expired ref
 * (todo_agent.md B2: generic failure messages).
 */
export async function completeVerification(
  executor: ActorTransaction,
  params: CompleteVerificationParams,
): Promise<Ulid | null> {
  // Two distinct statements, not one with a conditional self-reference:
  // unlisted_app has no SELECT grant on identity_hash at all (B2 encryption-
  // at-rest decision), and `identity_hash = identity_hash` would need one --
  // any expression that reads a column's existing value needs SELECT on it,
  // even on the right-hand side of its own assignment. Omitting the column
  // from the statement entirely avoids that requirement.
  const statement =
    params.verificationState === 'verified'
      ? sql`
          UPDATE "user"
          SET verification_state = ${params.verificationState},
              verification_ref = NULL,
              age = ${params.age},
              identity_hash = ${params.identityHash}
          WHERE verification_ref = ${params.vendorSessionRef}
          RETURNING id
        `
      : sql`
          UPDATE "user"
          SET verification_state = ${params.verificationState},
              verification_ref = NULL
          WHERE verification_ref = ${params.vendorSessionRef}
          RETURNING id
        `;

  try {
    const result = await executor.execute(statement);
    const row = result.rows[0] as { id: Ulid } | undefined;
    return row?.id ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}
