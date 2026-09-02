/**
 * Data layer: Drizzle schema, migrations, and repositories.
 *
 * All database access lives under this directory and nowhere else. Every
 * repository function takes an `actor` as its first argument and scopes the
 * query to what that actor may see; block and enforcement filters are applied
 * inside the query, never after fetching. No unscoped `findMany` exists outside
 * an explicitly named admin module.
 *
 * Populated from task A2 (schema and migrations) onward.
 */
export {};
