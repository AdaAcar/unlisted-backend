import { resolve } from 'node:path';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import * as schema from '@/db/schema';

const MIGRATIONS_FOLDER = resolve(__dirname, '../../../db/migrations');

/**
 * Resolve the test database URL, or fail loudly. These tests verify database
 * constraints and must run against real Postgres — they do not skip.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      [
        'TEST_DATABASE_URL is not set.',
        'The schema constraint tests require a real Postgres and do NOT skip.',
        '',
        '  1. Start Postgres:  pnpm db:up',
        '  2. Set TEST_DATABASE_URL (see .env.example), e.g. in .env.local:',
        '     TEST_DATABASE_URL=postgres://unlisted:unlisted@localhost:5433/unlisted_test',
      ].join('\n'),
    );
  }
  return url;
}

export interface TestDb {
  db: NodePgDatabase<typeof schema>;
  pool: Pool;
  close: () => Promise<void>;
}

/**
 * A freshly-migrated, empty database. Drops and recreates both the `public`
 * schema (entity tables) and the `drizzle` schema (migration bookkeeping) so
 * every call starts from nothing and re-runs every migration.
 */
export async function freshDb(): Promise<TestDb> {
  const pool = new Pool({ connectionString: testDatabaseUrl() });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('CREATE SCHEMA public');

  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return { db, pool, close: () => pool.end() };
}
