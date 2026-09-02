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

let pool: Pool | undefined;
let database: NodePgDatabase<typeof schema> | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: env.databaseUrl });
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!database) {
    database = drizzle(getPool(), { schema });
  }
  return database;
}

/** Close the pool. For test teardown and graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}
