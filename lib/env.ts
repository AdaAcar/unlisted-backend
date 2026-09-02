/**
 * Infrastructure configuration, read from the environment.
 *
 * Kept strictly separate from `lib/config.ts`: that file holds product
 * parameters (structural invariants) and never reads the environment; this file
 * holds deployment wiring (connection strings) and only reads the environment.
 * The two never merge.
 *
 * Values are read lazily through getters so that importing this module never
 * throws — a missing variable fails only when something actually needs it.
 */

function parsePostgresUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Environment variable ${name} is not a valid URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`Environment variable ${name} must be a postgres:// connection string`);
  }
  return raw;
}

function optionalPostgresUrl(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return parsePostgresUrl(name, raw);
}

function requiredPostgresUrl(name: string): string {
  const value = optionalPostgresUrl(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  /** Primary database connection string. Required at runtime. */
  get databaseUrl(): string {
    return requiredPostgresUrl('DATABASE_URL');
  },

  /**
   * Database used by the integration test suite. The schema constraint tests
   * require this to be set — they fail rather than skip when it is absent.
   */
  get testDatabaseUrl(): string | undefined {
    return optionalPostgresUrl('TEST_DATABASE_URL');
  },
};
