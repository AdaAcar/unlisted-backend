import { createHmac } from 'node:crypto';

import { env } from './env';

/**
 * Hashes the identity reference a verification vendor asserts, before it is
 * ever written to `user.identity_hash` (B2, todo_agent.md). Keyed HMAC-SHA-256
 * under a dedicated `IDENTITY_HASH_SECRET` — not `lib/hash.ts`'s
 * `AUDIT_HASH_SECRET`, a different key for a different purpose (see
 * `lib/env.ts`). This is what makes `identity_hash` non-reversible to the
 * underlying identity: only a hash is ever stored, never the vendor's raw
 * reference or any document.
 */
export function hashIdentity(identityReference: string): string {
  return createHmac('sha256', env.identityHashSecret).update(identityReference).digest('hex');
}
