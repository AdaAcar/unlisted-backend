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

/**
 * HMAC key for `lib/identityHash.ts`. Deliberately a separate secret from
 * `AUDIT_HASH_SECRET`: different purpose (ban-durability identity matching,
 * not audit-metadata hashing) and different rotation cost (rotating this one
 * breaks ban durability for every already-hashed identity, not audit
 * correlation), so tying them together would couple two unrelated
 * operational decisions to one key.
 */
const IDENTITY_HASH_SECRET_MIN_BYTES = 32;

const identityHashSecret = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') >= IDENTITY_HASH_SECRET_MIN_BYTES, {
    message: `must be at least ${IDENTITY_HASH_SECRET_MIN_BYTES} bytes`,
  });

function parseIdentityHashSecret(): string {
  const raw = process.env.IDENTITY_HASH_SECRET;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('Missing required environment variable: IDENTITY_HASH_SECRET');
  }

  const result = identityHashSecret.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid environment variable IDENTITY_HASH_SECRET: ${detail}`);
  }
  return result.data;
}

/** HMAC key `lib/verificationVendor.ts`'s stub uses to sign/verify webhook bodies. */
const VERIFICATION_WEBHOOK_SECRET_MIN_BYTES = 32;

const verificationWebhookSecret = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') >= VERIFICATION_WEBHOOK_SECRET_MIN_BYTES, {
    message: `must be at least ${VERIFICATION_WEBHOOK_SECRET_MIN_BYTES} bytes`,
  });

function parseVerificationWebhookSecret(): string {
  const raw = process.env.VERIFICATION_WEBHOOK_SECRET;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('Missing required environment variable: VERIFICATION_WEBHOOK_SECRET');
  }

  const result = verificationWebhookSecret.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid environment variable VERIFICATION_WEBHOOK_SECRET: ${detail}`);
  }
  return result.data;
}

const VERIFICATION_VENDORS = ['stub'] as const;
export type VerificationVendorName = (typeof VERIFICATION_VENDORS)[number];

/**
 * Feature flag selecting the verification vendor implementation
 * (todo_agent.md B2). Lives here, not in `lib/config.ts`: it is read from
 * the environment, and `config` never reads the environment by decision
 * (see `lib/config.ts`'s doc comment). Defaults to 'stub' when unset — the
 * stub is correct for now (todo_agent.md), and no real vendor exists yet for
 * any other value to mean.
 */
function parseVerificationVendor(): VerificationVendorName {
  const raw = process.env.VERIFICATION_VENDOR;
  if (raw === undefined || raw.trim() === '') return 'stub';
  if ((VERIFICATION_VENDORS as readonly string[]).includes(raw)) {
    return raw as VerificationVendorName;
  }
  throw new Error(`Invalid environment variable VERIFICATION_VENDOR: unrecognized vendor "${raw}"`);
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

  /**
   * HMAC key used to hash a verification vendor's asserted identity
   * reference before it becomes `user.identity_hash` (see
   * `lib/identityHash.ts`). Required, fails closed the same way
   * `auditHashSecret` does. Rotating this key breaks ban-durability
   * correlation for every already-hashed identity — do not rotate expecting
   * continuity.
   */
  get identityHashSecret(): string {
    return parseIdentityHashSecret();
  },

  /**
   * HMAC key the stub verification vendor (`lib/verificationVendor.ts`) uses
   * to sign and verify webhook request bodies. Required, fails closed.
   */
  get verificationWebhookSecret(): string {
    return parseVerificationWebhookSecret();
  },

  /** Feature flag selecting the verification vendor. Defaults to 'stub'. */
  get verificationVendor(): VerificationVendorName {
    return parseVerificationVendor();
  },
};
