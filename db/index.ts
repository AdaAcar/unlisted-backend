/**
 * Data layer entry point.
 *
 * All database access lives under this directory and nowhere else. Repositories
 * (A3) will each take an `actor` first and scope the query; block and
 * enforcement filters will be applied inside the query, never after fetching.
 *
 * For now this exposes the schema and the lazy connection wiring only.
 */
export * as schema from './schema';
export { getDb, getPool, closeDb } from './client';
