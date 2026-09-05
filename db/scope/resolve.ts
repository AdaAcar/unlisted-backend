import { and, eq, gt } from 'drizzle-orm';

import { withAdmin } from '@/db/admin';
import { session, user } from '@/db/schema';
import { hashSessionToken } from '@/lib/sessionToken';

import type { Ulid, UserActor } from './actor';

/**
 * B1's seam: resolve the data-layer actor fields for an already-authenticated
 * user id. This is deliberately a narrow unscoped read, not authentication.
 */
export async function loadActorByUserId(userId: Ulid): Promise<UserActor> {
  const rows = await withAdmin((executor) =>
    executor
      .select({
        id: user.id,
        verificationState: user.verificationState,
        standing: user.standing,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) throw new Error('Actor user does not exist');
  return { kind: 'user', ...row };
}

/**
 * B1's stubbed credential port: `authenticate(credential) -> userId`. There
 * is no login factor in this codebase, deliberately (docs/state.md
 * Decisions) — the "credential" is the userId itself. This is honest about
 * what B1 actually proves (session lifecycle behind this seam), rather than
 * inventing a password/OTP/magic-link model to make the seam look real.
 *
 * A non-existent user and a banned one are rejected identically (both
 * return null) — with no other credential factor to be "wrong" about, the
 * banned case is what gives the enumeration-via-error-text property
 * something real to test against.
 */
export async function authenticate(credential: { userId: Ulid }): Promise<Ulid | null> {
  const rows = await withAdmin((executor) =>
    executor
      .select({ id: user.id, standing: user.standing })
      .from(user)
      .where(eq(user.id, credential.userId))
      .limit(1),
  );
  const row = rows[0];
  if (!row || row.standing === 'banned') return null;
  return row.id;
}

interface CookieSource {
  headers: { get(name: string): string | null };
}

export const SESSION_COOKIE_NAME = 'session';

/** The raw bearer token from the request's cookie header, if present. */
export function extractSessionToken(request: CookieSource): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

interface ActiveSession {
  id: Ulid;
  userId: Ulid;
}

/**
 * The one unscoped, pre-authentication read against `session`: no actor is
 * known yet, so there is nothing to scope the query to. Same shape as
 * `loadActorByUserId` and `authenticate` above. Shared by `getSessionActor`
 * and `getSessionContext` below so the lookup itself is written once.
 */
async function resolveActiveSession(tokenHash: string): Promise<ActiveSession | undefined> {
  const rows = await withAdmin((executor) =>
    executor
      .select({ id: session.id, userId: session.userId })
      .from(session)
      .where(and(eq(session.tokenHash, tokenHash), gt(session.expiresAt, new Date())))
      .limit(1),
  );
  return rows[0];
}

/**
 * Sits in front of the existing `loadActorByUserId` (A3 decision: that
 * loader's shape does not change). Returns null rather than throwing for any
 * failure (no cookie, unknown token, expired session): "no session" is a
 * normal outcome for a caller to branch on, not an error to catch. This is
 * the shape most route handlers need — just the actor, to authorize and act.
 */
export async function getSessionActor(request: CookieSource): Promise<UserActor | null> {
  const token = extractSessionToken(request);
  if (!token) return null;

  const found = await resolveActiveSession(hashSessionToken(token));
  if (!found) return null;

  return loadActorByUserId(found.userId);
}

/**
 * Like `getSessionActor`, but also hands back the session's own id and token
 * hash. `DELETE /auth/session` needs both: which row to revoke (there is no
 * `SELECT` grant on `session` for `unlisted_app`, so it cannot look this up
 * for itself inside the mutating transaction — see migration 0007) and what
 * to record as the audit entry's `resourceId`.
 */
export async function getSessionContext(
  request: CookieSource,
): Promise<{ actor: UserActor; sessionId: Ulid; tokenHash: string } | null> {
  const token = extractSessionToken(request);
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const found = await resolveActiveSession(tokenHash);
  if (!found) return null;

  const actor = await loadActorByUserId(found.userId);
  return { actor, sessionId: found.id, tokenHash };
}
