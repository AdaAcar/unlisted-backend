import { defineConfig } from 'drizzle-kit';

/**
 * `drizzle-kit generate` (schema -> SQL) needs no database connection.
 * `drizzle-kit migrate` / `studio` use `dbCredentials`; the integration tests
 * run migrations programmatically against `TEST_DATABASE_URL` instead.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema/index.ts',
  out: './db/migrations',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
