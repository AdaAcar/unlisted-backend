import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import * as schema from '@/db/schema';
import { closeDb } from '@/db/client';

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
  adminLoginUrl: string;
  appLoginUrl: string;
  db: NodePgDatabase<typeof schema>;
  deployerLoginUrl: string;
  pool: Pool;
  postMigrationRoles: {
    rolbypassrls: boolean;
    rolcanlogin: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolname: string;
    rolpassword: string | null;
    rolreplication: boolean;
    rolsuper: boolean;
  }[];
  close: () => Promise<void>;
}

const TEST_LOGIN_ROLES = [
  'unlisted_test_app_login',
  'unlisted_test_admin_login',
  'unlisted_test_deployer_login',
] as const;

function loginUrl(role: string, password: string): string {
  const url = new URL(testDatabaseUrl());
  url.username = role;
  url.password = password;
  return url.toString();
}

/**
 * A freshly-migrated, empty database. Drops and recreates both the `public`
 * schema (entity tables) and the `drizzle` schema (migration bookkeeping) so
 * every call starts from nothing and re-runs every migration.
 */
export async function freshDb(): Promise<TestDb> {
  await closeDb();
  const pool = new Pool({ connectionString: testDatabaseUrl() });
  await pool.query(`DROP ROLE IF EXISTS ${TEST_LOGIN_ROLES.join(', ')}`);
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('CREATE SCHEMA public');

  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const postMigrationRoles = (
    await pool.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolname: string;
      rolpassword: string | null;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolname, rolcanlogin, rolbypassrls, rolpassword, rolsuper,
              rolcreatedb, rolcreaterole, rolinherit, rolreplication
       FROM pg_authid
       WHERE rolname IN ('unlisted_app', 'unlisted_admin', 'unlisted_migrator')
       ORDER BY rolname`,
    )
  ).rows;

  const password = randomBytes(18).toString('hex');
  await pool.query(`CREATE ROLE unlisted_test_app_login LOGIN NOINHERIT PASSWORD '${password}'`);
  await pool.query(`CREATE ROLE unlisted_test_admin_login LOGIN NOINHERIT PASSWORD '${password}'`);
  await pool.query(
    `CREATE ROLE unlisted_test_deployer_login LOGIN NOINHERIT PASSWORD '${password}'`,
  );
  await pool.query(`GRANT unlisted_app TO unlisted_test_app_login`);
  await pool.query(`GRANT unlisted_admin TO unlisted_test_admin_login`);
  await pool.query(`GRANT unlisted_migrator TO unlisted_test_deployer_login`);

  const appLoginUrl = loginUrl('unlisted_test_app_login', password);
  const adminLoginUrl = loginUrl('unlisted_test_admin_login', password);
  const deployerLoginUrl = loginUrl('unlisted_test_deployer_login', password);
  process.env.APP_DATABASE_URL = appLoginUrl;
  process.env.ADMIN_DATABASE_URL = adminLoginUrl;

  return {
    adminLoginUrl,
    appLoginUrl,
    db,
    deployerLoginUrl,
    pool,
    postMigrationRoles,
    close: async () => {
      await closeDb();
      await pool.query(`DROP ROLE IF EXISTS ${TEST_LOGIN_ROLES.join(', ')}`);
      await pool.end();
    },
  };
}
