import { createHash, randomBytes } from 'node:crypto';

/**
 * Server-side session bearer tokens (B1). Distinct from `lib/hash.ts`: that
 * file hashes personal request metadata (IP, user agent) that has a small
 * enough input space to need a *keyed* HMAC against brute-forcing. A session
 * token is generated here with 256 bits of randomness, so a plain SHA-256
 * digest of it cannot be brute-forced — no secret is needed. The digest
 * exists only so a DB dump or backup does not hand over a live bearer
 * credential directly; the raw token is never stored.
 */

const TOKEN_BYTES = 32;

/**
 * Absolute session lifetime. Not in `lib/config.ts`: that file is exactly
 * the section-5 product parameters (`tests/unit/bootstrap.test.ts` pins its
 * shape against agent-rules.md, which is read-only), and a session TTL is
 * neither one of those nor read from the environment — it lives with the
 * one thing that uses it.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The value set in the session cookie. Never stored — only its hash is. */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Lookup key stored in `session.token_hash`. Unkeyed by design; see above. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
