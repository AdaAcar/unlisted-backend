import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDb, type TestDb } from './support/db';

const execFileAsync = promisify(execFile);
const MIGRATIONS = resolve(__dirname, '../../db/migrations');
const RUNNER = resolve(__dirname, '../../db/migrate.mjs');

let t: TestDb;
let futureOffset = 0;
const temporaryDirectories: string[] = [];

function isolatedFutureMigration(tag: string, sql: string): string {
  const root = mkdtempSync(join(tmpdir(), 'unlisted-migrations-'));
  temporaryDirectories.push(root);
  const migrations = join(root, 'migrations');
  cpSync(MIGRATIONS, migrations, { recursive: true });

  const journalPath = join(migrations, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; when: number; tag: string; version: string; breakpoints: boolean }[];
  };
  const previous = journal.entries.at(-1);
  journal.entries.push({
    idx: (previous?.idx ?? -1) + 1,
    version: '7',
    when: (previous?.when ?? Date.now()) + (futureOffset += 1_000),
    tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  writeFileSync(join(migrations, `${tag}.sql`), sql);
  return migrations;
}

async function invokeRunner(migrationsFolder: string): Promise<void> {
  await execFileAsync(process.execPath, [RUNNER, '--migrations-folder', migrationsFolder], {
    env: { ...process.env, DATABASE_URL: t.deployerLoginUrl },
  });
}

beforeAll(async () => {
  t = await freshDb({ bootstrapRunner: true });
});

afterAll(async () => {
  await t?.close();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe('transaction-local migration capability activation', () => {
  it('lets the one-shot bootstrap runner execute and record all of 0010', async () => {
    const state = await t.pool.query<{ n: number; schema_owner: string; table_owner: string }>(
      `SELECT
         (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS n,
         pg_get_userbyid(n.nspowner) AS schema_owner,
         pg_get_userbyid(c.relowner) AS table_owner
       FROM pg_namespace n
       JOIN pg_class c ON c.relnamespace = n.oid
        AND c.relname = '__drizzle_migrations'
       WHERE n.nspname = 'drizzle'`,
    );
    expect(state.rows).toEqual([
      { n: 11, schema_owner: 'unlisted_migrator', table_owner: 'unlisted_migrator' },
    ]);
  });

  it('denies the NOINHERIT deployer before role activation, then records and owns a future migration', async () => {
    const migrations = isolatedFutureMigration(
      '0011_future_probe',
      'CREATE TABLE public.a3_future_migration_probe (id integer PRIMARY KEY);\n',
    );

    const rawClient = new Client({ connectionString: t.deployerLoginUrl });
    await rawClient.connect();
    try {
      await expect(migrate(drizzle(rawClient), { migrationsFolder: migrations })).rejects.toThrow();
    } finally {
      await rawClient.end();
    }

    const before = await t.pool.query<{ table_name: string | null }>(
      `SELECT to_regclass('public.a3_future_migration_probe')::text AS table_name`,
    );
    expect(before.rows[0]?.table_name).toBeNull();
    expect((await t.pool.query(`SELECT * FROM drizzle.__drizzle_migrations`)).rowCount).toBe(11);

    await invokeRunner(migrations);

    const applied = await t.pool.query<{ n: number; owner: string }>(
      `SELECT
         (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS n,
         pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       WHERE c.oid = 'public.a3_future_migration_probe'::regclass`,
    );
    expect(applied.rows).toEqual([{ n: 12, owner: 'unlisted_migrator' }]);
  });

  it('permanently closes its dedicated connection when a migration fails', async () => {
    const migrations = isolatedFutureMigration(
      '0009_broken_probe',
      'CREATE TABLE public.a3_broken_probe (id integer);\nTHIS IS NOT SQL;\n',
    );

    await expect(invokeRunner(migrations)).rejects.toThrow();

    const state = await t.pool.query<{ active: number; table_name: string | null }>(
      `SELECT
         (SELECT count(*)::int FROM pg_stat_activity
          WHERE usename = 'unlisted_test_deployer_login') AS active,
         to_regclass('public.a3_broken_probe')::text AS table_name`,
    );
    expect(state.rows).toEqual([{ active: 0, table_name: null }]);
  });
});
