import { sql } from 'drizzle-orm';
import { check, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { user } from './user';

/**
 * Server-side session (B1, todo_agent.md). The bearer token itself never
 * reaches storage: `token_hash` is a plain SHA-256 digest of it
 * (`lib/hash.ts`'s `hashSessionToken`). Unlike `ip_hash`/`user_agent_hash`,
 * this doesn't need a keyed HMAC — the token already carries 256 bits of
 * server-generated entropy, so an unkeyed digest cannot be brute-forced. The
 * hash exists only so a DB dump or backup does not hand over a live bearer
 * credential directly.
 *
 * Rotation (on privilege change) and revocation (logout, individual kill)
 * both delete a row rather than mutate one in place — there is no
 * `revoked_at` flag. That is why migration 0007 grants `unlisted_app`
 * INSERT + DELETE only, no UPDATE.
 */
export const session = pgTable(
  'session',
  {
    id: ulidPrimaryKey(),
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    ulidFormatCheck('session_id_ulid_chk', t.id),
    check('session_token_hash_chk', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex('session_token_hash_uq').on(t.tokenHash),
  ],
);
