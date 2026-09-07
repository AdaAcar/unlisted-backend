/**
 * The application "version hash" (task C5). Pure, no DB imports.
 *
 * A6 built `voidStaleConfirmations` (domain/application-planned.ts) as a plain
 * string compare and deliberately left *producing* the hash to C5. This is it.
 *
 * There is no `version_hash` column on `application` -- only
 * `application_member.confirmed_version_hash`. The current version is derived
 * from the application's consented content and compared against what each
 * member confirmed, so editing the note or the member set changes the hash for
 * free and every stale confirmation is voided with no stored state to clear.
 *
 * That only works if the serialization is canonical:
 *
 * - `v: 1` -- an explicit scheme version, so the canonical form can change
 *   later without silently revaluing historical confirmations.
 * - `note` -- Unicode NFC-normalised and trimmed. Internal whitespace is *not*
 *   collapsed: two visibly different notes must never hash equal.
 * - `members` -- the included member user ids, de-duplicated and sorted, so map
 *   iteration order in the caller cannot change the hash.
 * - Fixed key order (`v`, `note`, `members`) in the object literal, which
 *   `JSON.stringify` preserves for string keys.
 *
 * Nothing time-dependent, no ids, nothing mutable-but-irrelevant enters the
 * input -- any non-determinism would produce spurious voiding that looks like
 * a flaky test.
 *
 * Unkeyed SHA-256 is correct here: this is a change-detector, not a token.
 * Only collision resistance matters and there is no secret to protect
 * (contrast lib/hash.ts's keyed IP/UA hashing, which exists because an IP has
 * a brute-forceable preimage space).
 */
import { createHash } from 'node:crypto';

import type { Ulid } from './types';

export interface ApplicationVersionInput {
  /** The application note as stored (`null` and `''` are equivalent). */
  readonly note: string | null;
  /**
   * The user ids of every member included in the application -- the set being
   * consented to. For a solo application this is empty and the hash is moot
   * (nobody confirms).
   */
  readonly memberIds: readonly Ulid[];
}

export function computeApplicationVersionHash(input: ApplicationVersionInput): string {
  const canonical = JSON.stringify({
    v: 1,
    note: (input.note ?? '').normalize('NFC').trim(),
    members: [...new Set(input.memberIds)].sort(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
