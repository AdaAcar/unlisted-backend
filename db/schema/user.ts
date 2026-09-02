import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { softDelete, timestamps, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { userStandingEnum, verificationStateEnum } from './enums';

/**
 * A person. No surname is stored. The date of birth is never stored — the
 * verification vendor asserts 18+ and returns an age, and only the age is kept
 * (docs/data-model.md, CLAUDE.md section 3).
 *
 * `identity_hash` and `verification_ref` are `restricted`: encryption at rest
 * with a separate key and separate access control is applied in B2. They are on
 * their own columns here and annotated via COMMENT in 0001_guards.sql.
 */
export const user = pgTable(
  'user',
  {
    id: ulidPrimaryKey(),
    firstName: varchar('first_name', { length: 80 }).notNull(),
    /** 0–2 storage keys. EXIF is stripped server-side on upload (later task). */
    photos: text('photos')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    bio: text('bio'),
    /** Null until verification completes. Never a date of birth. */
    age: integer('age'),
    district: varchar('district', { length: 80 }),
    verificationState: verificationStateEnum('verification_state').notNull().default('none'),
    verificationRef: text('verification_ref'),
    identityHash: text('identity_hash'),
    standing: userStandingEnum('standing').notNull().default('good'),
    signalScore: integer('signal_score').notNull().default(0),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    ulidFormatCheck('user_id_ulid_chk', t.id),
    check('user_age_adult_chk', sql`${t.age} IS NULL OR ${t.age} >= 18`),
    check('user_photos_max_chk', sql`cardinality(${t.photos}) <= 2`),
    // Ban durability: a re-verified identity cannot open a second account.
    // Nullable, so unverified users do not collide on NULL.
    uniqueIndex('user_identity_hash_uq').on(t.identityHash),
  ],
);
