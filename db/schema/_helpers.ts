import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { check, timestamp, varchar } from 'drizzle-orm/pg-core';
import { ulid } from 'ulidx';

/**
 * Shared column helpers. Every entity in this schema uses these so the
 * conventions in docs/agent-rules.md section 3 and docs/data-model.md are applied
 * uniformly: ULID identifiers (never sequential integers), `timestamptz`
 * everywhere, DB-defaulted timestamps.
 */

/** ULID length in Crockford base32. */
export const ULID_LENGTH = 26;

/** Crockford base32, first char limited so the value fits 128 bits. */
export const ULID_PATTERN = '^[0-7][0-9A-HJKMNP-TV-Z]{25}$';

/**
 * Primary-key column: `varchar(26)`, generated application-side as a ULID.
 * Stored as text rather than `uuid` for debuggability (see docs/state.md section 10).
 */
export const ulidPrimaryKey = (name = 'id') =>
  varchar(name, { length: ULID_LENGTH })
    .primaryKey()
    .$defaultFn(() => ulid());

/** A ULID-shaped column that is not a primary key (FK target set by the caller). */
export const ulidColumn = (name: string) => varchar(name, { length: ULID_LENGTH });

/**
 * DB-level format guard for an id-bearing column. This is the constraint-level
 * expression of "all IDs are ULIDs"; it rejects sequential integers and exposed
 * database keys at write time.
 */
export const ulidFormatCheck = (constraintName: string, column: AnyPgColumn) =>
  check(constraintName, sql`${column} ~ ${sql.raw(`'${ULID_PATTERN}'`)}`);

/**
 * `created_at` / `updated_at`. Both DB-defaulted. `updated_at` is maintained by
 * the `set_updated_at` trigger installed in migration 0001_guards.sql, not by
 * the ORM.
 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * `deleted_at` soft-delete marker, for rows under a retention obligation
 * (docs/data-model.md). Erasure of personal data is a different, hard-delete
 * code path and is not represented by this column.
 */
export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
