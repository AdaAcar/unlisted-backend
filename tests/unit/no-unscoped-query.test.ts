import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  databaseBoundaryViolations,
  scanDatabaseBoundary,
  TRUSTED_DATABASE_FILES,
} from './support/database-boundary';

const ROOT = resolve(__dirname, '../..');
const DB_ROOT = join(ROOT, 'db');

describe('database scoping chokepoint', () => {
  it('keeps all database modules behind exact trusted-file boundaries', () => {
    expect(scanDatabaseBoundary(ROOT, DB_ROOT)).toEqual([]);
  });

  it.each([
    ['static pg import', `import pg from 'pg';`],
    ['pg subpath require', `const pool = require('pg/lib/pool');`],
    ['drizzle export', `export { drizzle } from 'drizzle-orm/node-postgres/session';`],
    ['dynamic client import', `const raw = await import('../client.ts');`],
    ['client subpath', `import pool from './client/pool.js';`],
    ['client alias', `export { getPool } from '@/db/client.mjs';`],
    ['alternate alias', `const db = require('#db/admin');`],
    ['admin relative path', `import { withAdmin } from '../../admin/index';`],
    ['pool acquisition', `const pool = getPool(); passToElsewhere(pool);`],
    ['db acquisition', `export const raw = getDb();`],
    ['app acquisition', `const value = getAppDb();`],
    ['admin acquisition', `const value = getAdminDb();`],
    ['named admin executor', `await withAdmin(run);`],
    ['query', `await value.query('select 1');`],
    ['connect', `await value.connect();`],
    ['select', `await value.select().from(table);`],
    ['execute', `await value.execute(statement);`],
    ['transaction', `await value.transaction(run);`],
    ['$client', `export const leaked = value.$client;`],
  ])('rejects adversarial %s samples', (_name, source) => {
    expect(databaseBoundaryViolations('db/new-module.ts', source)).not.toEqual([]);
  });

  it('does not grant directory-wide trust to future scope or admin modules', () => {
    expect(databaseBoundaryViolations('db/scope/future.ts', `getPool()`)).not.toEqual([]);
    expect(
      databaseBoundaryViolations('db/admin/future.ts', `export { getDb } from '../client'`),
    ).not.toEqual([]);
    expect([...TRUSTED_DATABASE_FILES].some((entry) => entry.includes('*'))).toBe(false);
  });

  it('keeps the lint exception list exact', () => {
    const eslint = JSON.parse(readFileSync(join(ROOT, '.eslintrc.json'), 'utf8')) as {
      overrides?: { files?: string[] }[];
    };
    const trusted = eslint.overrides?.flatMap((override) => override.files ?? []) ?? [];
    expect(trusted.some((entry) => entry.includes('**'))).toBe(false);
    expect(new Set(trusted)).toEqual(
      new Set([
        'db/client.ts',
        'db/migrate.mjs',
        'db/scope/scoped.ts',
        'db/scope/resolve.ts',
        'db/admin/index.ts',
        'tests/integration/migration-fail-closed.test.ts',
        'tests/integration/migration-runner.test.ts',
        'tests/integration/support/db.ts',
        'tests/integration/rls-deny-by-default.test.ts',
        'tests/integration/repo-block-scoping.test.ts',
      ]),
    );
  });

  it('sets actor scope transaction-locally and never at session scope', () => {
    const source = readFileSync(join(DB_ROOT, 'scope/scoped.ts'), 'utf8');
    expect(source).not.toMatch(/SET\s+SESSION/i);
    expect(source.match(/set_config\([^\n]+true\)/g)).toHaveLength(2);
    expect(source).toContain('.transaction(');
    expect(source).toMatch(/SET LOCAL ROLE unlisted_app/);
  });

  it('sets admin capability transaction-locally through the named executor', () => {
    const source = readFileSync(join(DB_ROOT, 'admin/index.ts'), 'utf8');
    expect(source).not.toMatch(/SET\s+SESSION/i);
    expect(source).toContain('.transaction(');
    expect(source).toMatch(/SET LOCAL ROLE unlisted_admin/);
  });
});
