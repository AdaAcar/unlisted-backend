import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb } from '@/db/client';

import { testDatabaseUrl } from './support/db';

const SOURCE_MIGRATIONS = resolve(__dirname, '../../db/migrations');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'unlisted-fail-closed-'));
const migrations = join(temporaryRoot, 'migrations');
const journalPath = join(migrations, 'meta/_journal.json');
let pool: Pool;

interface Journal {
  version: string;
  dialect: string;
  entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
}

async function catalogState() {
  const functions = await pool.query(
    `SELECT p.oid::regprocedure::text AS identity,
            pg_get_functiondef(p.oid) AS definition,
            pg_get_userbyid(p.proowner) AS owner,
            p.proacl::text AS acl
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'app_current_actor_id', 'app_actor_present', 'app_user_visible',
          'app_circle_visible', 'app_plan_visible', 'app_application_visible'
        )
      ORDER BY identity`,
  );
  const policies = await pool.query(
    `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname`,
  );
  const grants = await pool.query(
    `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND grantee IN ('unlisted_app', 'unlisted_admin')
      ORDER BY grantee, table_name, privilege_type`,
  );
  return { functions: functions.rows, policies: policies.rows, grants: grants.rows };
}

beforeAll(async () => {
  await closeDb();
  mkdirSync(join(migrations, 'meta'), { recursive: true });
  const completeJournal = JSON.parse(
    readFileSync(join(SOURCE_MIGRATIONS, 'meta/_journal.json'), 'utf8'),
  ) as Journal;
  const through0003 = { ...completeJournal, entries: completeJournal.entries.slice(0, 4) };
  for (const entry of through0003.entries) {
    copyFileSync(join(SOURCE_MIGRATIONS, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
  }
  writeFileSync(journalPath, `${JSON.stringify(through0003, null, 2)}\n`);

  pool = new Pool({ connectionString: testDatabaseUrl() });
  await pool.query(
    'DROP ROLE IF EXISTS unlisted_test_app_login, unlisted_test_admin_login, unlisted_test_deployer_login',
  );
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(drizzle(pool), { migrationsFolder: migrations });
});

afterAll(async () => {
  await pool?.end();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('pre-ledger migration guard', () => {
  it('rolls the actual 0004 migration back while retaining the exact 0003 database', async () => {
    const userIds = [ulid(), ulid(), ulid()];
    const circleId = ulid();
    const venueId = ulid();
    const planId = ulid();
    await pool.query(
      `INSERT INTO "user" (id, first_name) VALUES
         ($1, 'Host A'), ($2, 'Host B'), ($3, 'Host C')`,
      userIds,
    );
    await pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'Hosts', $2)`, [
      circleId,
      userIds[0],
    ]);
    for (const [index, userId] of userIds.entries()) {
      await pool.query(
        `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
         VALUES ($1, $2, $3, $4, 'active', now())`,
        [ulid(), circleId, userId, index === 0 ? 'lead' : 'member'],
      );
    }
    await pool.query(
      `INSERT INTO venue (id, name, address, district, type)
       VALUES ($1, 'Venue', 'Address', 'Kadikoy', 'bar')`,
      [venueId],
    );
    await pool.query(
      `INSERT INTO plan (
         id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
         district, venue_type, state, mode, published_at, confirmed_host_count
       ) VALUES (
         $1, $2, $3, now() + interval '2 days', 2, 1,
         'Kadikoy', 'bar', 'published', 'planned', now(), 3
       )`,
      [planId, circleId, venueId],
    );
    await pool.query(`UPDATE plan SET viable_at = clock_timestamp() WHERE id = $1`, [planId]);
    const viable = await pool.query<{ viable_at: Date | null }>(
      `SELECT viable_at FROM plan WHERE id = $1`,
      [planId],
    );
    expect(viable.rows[0]?.viable_at).not.toBeNull();

    const before = await catalogState();
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
    const completeJournal = JSON.parse(
      readFileSync(join(SOURCE_MIGRATIONS, 'meta/_journal.json'), 'utf8'),
    ) as Journal;
    const entry0004 = completeJournal.entries[4];
    if (!entry0004) throw new Error('checked-in journal is missing 0004');
    journal.entries.push(entry0004);
    copyFileSync(
      join(SOURCE_MIGRATIONS, '0004_a3_corrections.sql'),
      join(migrations, '0004_a3_corrections.sql'),
    );
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    await expect(migrate(drizzle(pool), { migrationsFolder: migrations })).rejects.toThrow(
      /pre-ledger viable plan/,
    );

    const ledger = await pool.query<{ created_at: string }>(
      `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
    );
    expect(ledger.rows.map((row) => Number(row.created_at))).toEqual(
      completeJournal.entries.slice(0, 4).map((entry) => entry.when),
    );
    expect((await pool.query(`SELECT * FROM plan_participant_introduction`)).rowCount).toBe(0);

    const objects = await pool.query<{
      new_functions: number;
      new_policies: number;
      new_triggers: number;
      viable_fk: number;
    }>(
      `SELECT
         (SELECT count(*)::int
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname IN (
               'reject_plan_participant_introduction_mutation',
               'generate_introduction_ulid',
               'reconcile_plan_participant_introductions',
               'reconcile_introductions_from_plan',
               'reconcile_introductions_from_application',
               'reconcile_introductions_from_application_member',
               'app_actor_hosts_circle',
               'app_shared_introduction_visible'
             )) AS new_functions,
         (SELECT count(*)::int FROM pg_policies
           WHERE policyname IN (
             'user_app_read', 'user_admin_read', 'plan_introduction_migrator_read',
             'plan_introduction_migrator_insert'
           )) AS new_policies,
         (SELECT count(*)::int FROM pg_trigger
           WHERE NOT tgisinternal
             AND tgname IN (
               'plan_participant_introduction_no_update',
               'plan_participant_introduction_no_delete',
               'plan_reconcile_participant_introductions',
               'application_reconcile_participant_introductions',
               'application_member_reconcile_participant_introductions'
             )) AS new_triggers,
         (SELECT count(*)::int FROM pg_constraint
           WHERE conname = 'plan_participant_introduction_plan_viable_fk') AS viable_fk`,
    );
    expect(objects.rows).toEqual([
      { new_functions: 0, new_policies: 0, new_triggers: 0, viable_fk: 0 },
    ]);

    expect(await catalogState()).toEqual(before);
    const roles = await pool.query(
      `SELECT rolname, rolcanlogin, rolbypassrls
         FROM pg_roles
        WHERE rolname IN ('unlisted_app', 'unlisted_admin')
        ORDER BY rolname`,
    );
    expect(roles.rows).toEqual([
      { rolname: 'unlisted_admin', rolcanlogin: true, rolbypassrls: true },
      { rolname: 'unlisted_app', rolcanlogin: true, rolbypassrls: false },
    ]);
    expect(
      before.grants.filter(
        (grant) =>
          grant.grantee === 'unlisted_app' &&
          grant.table_name === 'plan' &&
          ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(grant.privilege_type),
      ),
    ).toHaveLength(4);
  });
});
