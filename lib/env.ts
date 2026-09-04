import { z } from 'zod';

/** Infrastructure wiring only. Product invariants remain in `lib/config.ts`. */

const postgresUrl = z
  .url()
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'must be a postgres:// or postgresql:// connection string',
  });

function parsePostgresUrl(name: string, required: true): string;
function parsePostgresUrl(name: string, required: false): string | undefined;
function parsePostgresUrl(name: string, required: boolean): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    if (required) throw new Error(`Missing required environment variable: ${name}`);
    return undefined;
  }

  const result = postgresUrl.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid environment variable ${name}: ${detail}`);
  }
  return result.data;
}

/**
 * HMAC key for `lib/hash.ts`, which hashes IP addresses and user agents
 * before an audit entry reaches `db/`. Minimum length guards against a
 * plausible-looking placeholder (`changeme`) silently producing hashes that
 * are technically keyed but trivially guessable.
 */
const AUDIT_HASH_SECRET_MIN_BYTES = 32;

const auditHashSecret = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') >= AUDIT_HASH_SECRET_MIN_BYTES, {
    message: `must be at least ${AUDIT_HASH_SECRET_MIN_BYTES} bytes`,
  });

function parseAuditHashSecret(): string {
  const raw = process.env.AUDIT_HASH_SECRET;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('Missing required environment variable: AUDIT_HASH_SECRET');
  }

  const result = auditHashSecret.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid environment variable AUDIT_HASH_SECRET: ${detail}`);
  }
  return result.data;
}

export const env = {
  /** Primary database connection string. Required at runtime. */
  get databaseUrl(): string {
    return parsePostgresUrl('DATABASE_URL', true);
  },

  /** Secret-backed login that assumes unlisted_app inside each transaction. */
  get appDatabaseUrl(): string {
    return parsePostgresUrl('APP_DATABASE_URL', true);
  },

  /** Secret-backed login that assumes unlisted_admin inside each transaction. */
  get adminDatabaseUrl(): string {
    return parsePostgresUrl('ADMIN_DATABASE_URL', true);
  },

  /**
   * Database used by the integration test suite. The schema constraint tests
   * require this to be set — they fail rather than skip when it is absent.
   */
  get testDatabaseUrl(): string | undefined {
    return parsePostgresUrl('TEST_DATABASE_URL', false);
  },

  /**
   * HMAC key used to hash IP addresses and user agents before an audit entry
   * reaches `db/` (see `lib/hash.ts`). Required, and fails closed: a missing
   * or too-short secret makes audit writes throw rather than produce a
   * reversible or trivially guessable hash. Rotating this key breaks
   * correlation with historical rows — do not rotate expecting continuity.
   */
  get auditHashSecret(): string {
    return parseAuditHashSecret();
  },
};
