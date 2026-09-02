import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '@/lib/env';

import * as schema from './schema';

/**
 * Connection wiring only. No query helpers and no repositories live here — those
 * arrive in A3, and every one of them will take an `actor` and scope its query.
 *
 * The pool and the Drizzle client are created lazily so that importing this
 * module (or anything that re-exports it) does not require `DATABASE_URL` to be
 * set — `tsc`, lint, and unit tests must not need a database.
 */

let ownerPool: Pool | undefined;
let ownerDatabase: NodePgDatabase<typeof schema> | undefined;
let appPool: Pool | undefined;
let appDatabase: NodePgDatabase<typeof schema> | undefined;
let adminPool: Pool | undefined;
let adminDatabase: NodePgDatabase<typeof schema> | undefined;

export function getPool(): Pool {
  if (!ownerPool) {
    ownerPool = new Pool({ connectionString: env.databaseUrl });
  }
  return ownerPool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!ownerDatabase) {
    ownerDatabase = drizzle(getPool(), { schema });
  }
  return ownerDatabase;
}

/** Internal RLS-subject connection. Import only from `db/scope/`. */
export function getAppDb(): NodePgDatabase<typeof schema> {
  if (!appPool) {
    appPool = new Pool({ connectionString: env.appDatabaseUrl });
    const created = drizzle(appPool, { schema });
    appDatabase = created;
    return created;
  }
  if (!appDatabase) throw new Error('Application database initialization failed');
  return appDatabase;
}

/** Internal BYPASSRLS connection. Import only from `db/scope/` or `db/admin/`. */
export function getAdminDb(): NodePgDatabase<typeof schema> {
  if (!adminPool) {
    adminPool = new Pool({ connectionString: env.adminDatabaseUrl });
    const created = drizzle(adminPool, { schema });
    adminDatabase = created;
    return created;
  }
  if (!adminDatabase) throw new Error('Admin database initialization failed');
  return adminDatabase;
}

/** Close the pool. For test teardown and graceful shutdown. */
export async function closeDb(): Promise<void> {
  await Promise.all([ownerPool?.end(), appPool?.end(), adminPool?.end()]);
  ownerPool = undefined;
  ownerDatabase = undefined;
  appPool = undefined;
  appDatabase = undefined;
  adminPool = undefined;
  adminDatabase = undefined;
}
