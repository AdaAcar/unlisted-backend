import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedPublishedPlan, type PlanFixture } from './support/a3';
import { freshDb, testDatabaseUrl, type TestDb } from './support/db';

let t: TestDb;
let fixture: PlanFixture;
let appLoginUrl: string;
let adminLoginUrl: string;

function loginUrl(role: string, password: string): string {
  const url = new URL(testDatabaseUrl());
  url.username = role;
  url.password = password;
  return url.toString();
}

beforeAll(async () => {
  t = await freshDb();
  fixture = await seedPublishedPlan(t);
  const password = randomBytes(18).toString('hex');
  await t.pool.query(`DROP ROLE IF EXISTS a3_test_app_login, a3_test_admin_login`);
  await t.pool.query(`CREATE ROLE a3_test_app_login LOGIN NOINHERIT PASSWORD '${password}'`);
  await t.pool.query(`CREATE ROLE a3_test_admin_login LOGIN NOINHERIT PASSWORD '${password}'`);
  await t.pool.query(`GRANT unlisted_app TO a3_test_app_login`);
  await t.pool.query(`GRANT unlisted_admin TO a3_test_admin_login`);
  appLoginUrl = loginUrl('a3_test_app_login', password);
  adminLoginUrl = loginUrl('a3_test_admin_login', password);
});

afterAll(async () => {
  await t?.pool.query(`DROP ROLE IF EXISTS a3_test_app_login, a3_test_admin_login`);
  await t?.close();
});

describe('RLS deny by default', () => {
  it('enables and forces RLS on every entity table', async () => {
    const result = await t.pool.query<{
      relforcerowsecurity: boolean;
      relname: string;
      relrowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
       ORDER BY relname`,
    );
    expect(result.rows).toHaveLength(14);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('leaves capability roles non-login, non-bypass, and without passwords', async () => {
    expect(t.postMigrationRoles).toEqual(
      expect.arrayContaining([
        {
          rolname: 'unlisted_app',
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolpassword: null,
          rolreplication: false,
          rolsuper: false,
        },
        {
          rolname: 'unlisted_admin',
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolpassword: null,
          rolreplication: false,
          rolsuper: false,
        },
        {
          rolname: 'unlisted_migrator',
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolpassword: null,
          rolreplication: false,
          rolsuper: false,
        },
      ]),
    );
    const owners = await t.pool.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relowner) AS owner
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    );
    expect(owners.rows).toEqual([{ owner: 'unlisted_migrator' }]);
  });

  it('keeps the ledger private and denies raw application-role mutations', async () => {
    const pool = new Pool({ connectionString: appLoginUrl });
    const attempt = async (statement: string, parameters: unknown[] = []): Promise<void> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE unlisted_app');
        await client.query(`SELECT set_config('app.actor_id', $1, true)`, [fixture.actorId]);
        await expect(client.query(statement, parameters)).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    };
    try {
      await attempt(`SELECT * FROM plan_participant_introduction`);
      await attempt(`INSERT INTO "user" (id, first_name) VALUES ($1, 'No')`, [
        '00000000000000000000000000',
      ]);
      await attempt(`UPDATE plan SET note = 'tampered' WHERE id = $1`, [fixture.planId]);
      await attempt(`DELETE FROM plan WHERE id = $1`, [fixture.planId]);
      expect(
        (await t.pool.query(`SELECT note FROM plan WHERE id = $1`, [fixture.planId])).rows[0],
      ).toEqual({ note: null });
    } finally {
      await pool.end();
    }
  });

  it('locks population behind exact owner policies and trigger-only function ACLs', async () => {
    const policies = await t.pool.query<{
      cmd: string;
      policyname: string;
      tablename: string;
      withCheck: string | null;
    }>(
      `SELECT policyname, tablename, cmd, with_check AS "withCheck"
       FROM pg_policies
       WHERE schemaname = 'public' AND 'unlisted_migrator' = ANY(roles)
       ORDER BY policyname`,
    );
    expect(
      policies.rows.map(({ cmd, policyname, tablename }) => ({ cmd, policyname, tablename })),
    ).toEqual(
      [
        ['application_member_migrator_population_read', 'application_member', 'SELECT'],
        ['application_migrator_population_read', 'application', 'SELECT'],
        ['circle_member_migrator_population_read', 'circle_member', 'SELECT'],
        ['plan_introduction_migrator_insert', 'plan_participant_introduction', 'INSERT'],
        ['plan_introduction_migrator_read', 'plan_participant_introduction', 'SELECT'],
        ['plan_migrator_population_lock', 'plan', 'UPDATE'],
        ['plan_migrator_population_read', 'plan', 'SELECT'],
      ].map(([policyname, tablename, cmd]) => ({ cmd, policyname, tablename })),
    );
    expect(
      policies.rows.find((row) => row.policyname === 'plan_migrator_population_lock')?.withCheck,
    ).toBe('false');

    const functions = await t.pool.query<{
      adminCanExecute: boolean;
      adminLoginCanExecute: boolean;
      appCanExecute: boolean;
      appLoginCanExecute: boolean;
      config: string[] | null;
      deployerLoginCanExecute: boolean;
      identity: string;
      owner: string;
      ownerCanExecute: boolean;
      publicCanExecute: boolean;
      securityDefiner: boolean;
    }>(
      `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS identity,
              pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS "securityDefiner",
              p.proconfig AS config,
              EXISTS (
                SELECT 1
                  FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                 WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS "publicCanExecute",
              has_function_privilege('unlisted_app', p.oid, 'EXECUTE') AS "appCanExecute",
              has_function_privilege('unlisted_admin', p.oid, 'EXECUTE') AS "adminCanExecute",
              has_function_privilege('a3_test_app_login', p.oid, 'EXECUTE') AS "appLoginCanExecute",
              has_function_privilege('a3_test_admin_login', p.oid, 'EXECUTE') AS "adminLoginCanExecute",
              has_function_privilege(
                'unlisted_test_deployer_login', p.oid, 'EXECUTE'
              ) AS "deployerLoginCanExecute",
              has_function_privilege(pg_get_userbyid(p.proowner), p.oid, 'EXECUTE') AS "ownerCanExecute"
       FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN (
           'app_current_actor_id',
           'app_actor_present',
           'app_user_visible',
           'app_circle_visible',
           'app_plan_visible',
           'app_application_visible',
           'app_actor_hosts_circle',
           'reconcile_plan_participant_introductions',
           'reconcile_introductions_from_plan',
           'reconcile_introductions_from_application',
           'reconcile_introductions_from_application_member',
           'app_shared_introduction_visible',
           'generate_introduction_ulid',
           'reject_plan_participant_introduction_mutation'
         )
       ORDER BY identity`,
    );
    const appFunctions = new Set([
      'app_current_actor_id()',
      'app_actor_present()',
      'app_user_visible(counterparty_user_id character varying)',
      'app_circle_visible(counterparty_circle_id character varying)',
      'app_plan_visible(counterparty_plan_id character varying)',
      'app_application_visible(counterparty_application_id character varying)',
      'app_actor_hosts_circle(counterparty_circle_id character varying)',
      'app_shared_introduction_visible(subject_user_id character varying)',
    ]);
    const adminFunctions = new Set([
      'app_current_actor_id()',
      'app_actor_present()',
      'app_user_visible(counterparty_user_id character varying)',
      'app_circle_visible(counterparty_circle_id character varying)',
      'app_plan_visible(counterparty_plan_id character varying)',
      'app_application_visible(counterparty_application_id character varying)',
      'app_actor_hosts_circle(counterparty_circle_id character varying)',
    ]);
    const populationFunctions = new Set([
      'reconcile_plan_participant_introductions(target_plan_id character varying, introduction_time timestamp with time zone)',
      'reconcile_introductions_from_plan()',
      'reconcile_introductions_from_application()',
      'reconcile_introductions_from_application_member()',
    ]);
    for (const row of functions.rows) {
      expect(row.publicCanExecute).toBe(false);
      expect(row.appCanExecute, row.identity).toBe(appFunctions.has(row.identity));
      expect(row.adminCanExecute, row.identity).toBe(adminFunctions.has(row.identity));
      expect(row.appLoginCanExecute).toBe(false);
      expect(row.adminLoginCanExecute).toBe(false);
      expect(row.deployerLoginCanExecute).toBe(false);
      expect(row.ownerCanExecute).toBe(true);
      if (populationFunctions.has(row.identity)) {
        expect(row.owner).toBe('unlisted_migrator');
        expect(row.securityDefiner).toBe(true);
        expect(row.config).toContain('search_path=pg_catalog, public');
        expect(row.appCanExecute).toBe(false);
        expect(row.adminCanExecute).toBe(false);
      }
    }
    expect(functions.rows).toHaveLength(14);
  });

  it('grants app and admin exactly the six-table SELECT surface and no mutations', async () => {
    const privileges = await t.pool.query<{
      canDelete: boolean;
      canInsert: boolean;
      canReferences: boolean;
      canSelect: boolean;
      canTrigger: boolean;
      canTruncate: boolean;
      canUpdate: boolean;
      grantee: string;
      tableName: string;
    }>(
      `SELECT role_name AS grantee, table_name AS "tableName",
              has_table_privilege(role_name, format('%I.%I', 'public', table_name), 'SELECT') AS "canSelect",
              has_table_privilege(role_name, format('%I.%I', 'public', table_name), 'INSERT') AS "canInsert",
              has_table_privilege(role_name, format('%I.%I', 'public', table_name), 'UPDATE') AS "canUpdate",
              has_table_privilege(role_name, format('%I.%I', 'public', table_name), 'DELETE') AS "canDelete",
              has_table_privilege(role_name, format('%I.%I', 'public', table_name), 'TRUNCATE') AS "canTruncate",
              has_table_privilege(role_name, format('%I.%I', 'public', table_name), 'REFERENCES') AS "canReferences",
              has_table_privilege(role_name, format('%I.%I', 'public', table_name), 'TRIGGER') AS "canTrigger"
       FROM (VALUES ('unlisted_app'), ('unlisted_admin')) roles(role_name)
       CROSS JOIN information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY role_name, table_name`,
    );
    const allowed = new Set([
      'application',
      'application_member',
      'block',
      'circle_member',
      'plan',
      'user',
    ]);
    for (const row of privileges.rows) {
      expect(row.canSelect).toBe(allowed.has(row.tableName));
      expect(row.canInsert).toBe(false);
      expect(row.canUpdate).toBe(false);
      expect(row.canDelete).toBe(false);
      expect(row.canTruncate).toBe(false);
      expect(row.canReferences).toBe(false);
      expect(row.canTrigger).toBe(false);
    }
  });

  it('gives admin exactly six forced-RLS cross-actor SELECT policies', async () => {
    const policies = await t.pool.query<{ cmd: string; tablename: string }>(
      `SELECT tablename, cmd FROM pg_policies
       WHERE schemaname = 'public' AND 'unlisted_admin' = ANY(roles)
       ORDER BY tablename`,
    );
    expect(policies.rows).toEqual(
      ['application', 'application_member', 'block', 'circle_member', 'plan', 'user'].map(
        (tablename) => ({ cmd: 'SELECT', tablename }),
      ),
    );
  });

  it('gives the application capability exactly six scoped SELECT policies', async () => {
    const policies = await t.pool.query<{ cmd: string; tablename: string }>(
      `SELECT tablename, cmd FROM pg_policies
       WHERE schemaname = 'public' AND 'unlisted_app' = ANY(roles)
       ORDER BY tablename`,
    );
    expect(policies.rows).toEqual(
      ['application', 'application_member', 'block', 'circle_member', 'plan', 'user'].map(
        (tablename) => ({ cmd: 'SELECT', tablename }),
      ),
    );
  });

  it('returns zero rows to the app role when the actor GUC is unset', async () => {
    const pool = new Pool({ connectionString: appLoginUrl });
    try {
      await expect(pool.query('SELECT id FROM plan')).rejects.toThrow(
        /permission denied|does not exist/,
      );
      await expect(pool.query('SELECT app_actor_present()')).rejects.toThrow(
        /permission denied|does not exist/,
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE unlisted_app');
        const result = await client.query('SELECT id FROM plan');
        expect(result.rows).toEqual([]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('clears a transaction-local actor GUC before the same connection is reused', async () => {
    const pool = new Pool({
      connectionString: appLoginUrl,
      max: 1,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unlisted_app');
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [fixture.actorId]);
      await client.query(`SELECT set_config('app.actor_standing', 'good', true)`);
      expect((await client.query('SELECT id FROM plan')).rows).toHaveLength(1);
      await client.query('COMMIT');
      expect((await client.query('SELECT current_user')).rows[0]?.current_user).toBe(
        'a3_test_app_login',
      );
      await expect(client.query('SELECT id FROM plan')).rejects.toThrow(
        /permission denied|does not exist/,
      );
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unlisted_app');
      expect(
        (
          await client.query<{ actorId: string | null }>(
            `SELECT NULLIF(current_setting('app.actor_id', true), '') AS "actorId"`,
          )
        ).rows[0]?.actorId,
      ).toBeNull();
      await client.query('COMMIT');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('requires the admin login to assume its capability transaction-locally', async () => {
    const pool = new Pool({ connectionString: adminLoginUrl, max: 1 });
    const client = await pool.connect();
    try {
      await expect(client.query('SELECT id FROM "user"')).rejects.toThrow(
        /permission denied|does not exist/,
      );
      await expect(client.query('SELECT app_user_visible($1)', [fixture.actorId])).rejects.toThrow(
        /permission denied|does not exist/,
      );
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unlisted_admin');
      expect((await client.query('SELECT id FROM "user"')).rows.length).toBeGreaterThan(0);
      await client.query('COMMIT');
      expect((await client.query('SELECT current_user')).rows[0]?.current_user).toBe(
        'a3_test_admin_login',
      );
      await expect(client.query('SELECT id FROM "user"')).rejects.toThrow(
        /permission denied|does not exist/,
      );
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('requires the deployer login to assume the migrator capability locally', async () => {
    const pool = new Pool({ connectionString: t.deployerLoginUrl, max: 1 });
    const client = await pool.connect();
    try {
      expect(
        (
          await client.query<{ canCreate: boolean }>(
            `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreate"`,
          )
        ).rows[0]?.canCreate,
      ).toBe(false);
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unlisted_migrator');
      expect(
        (
          await client.query<{ canCreate: boolean }>(
            `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreate"`,
          )
        ).rows[0]?.canCreate,
      ).toBe(true);
      await client.query('COMMIT');
      expect((await client.query('SELECT current_user')).rows[0]?.current_user).toBe(
        'unlisted_test_deployer_login',
      );
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('does not let the population function owner update or delete ledger rows', async () => {
    await t.pool.query(
      `UPDATE plan SET confirmed_host_count = 3, viable_at = now() WHERE id = $1`,
      [fixture.planId],
    );
    expect(
      (
        await t.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM plan_participant_introduction WHERE plan_id = $1`,
          [fixture.planId],
        )
      ).rows[0]?.count,
    ).toBeGreaterThan(0);
    const pool = new Pool({ connectionString: t.deployerLoginUrl });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unlisted_migrator');
      const update = await client.query(
        `UPDATE plan_participant_introduction SET introduced_at = now()`,
      );
      const deletion = await client.query(`DELETE FROM plan_participant_introduction`);
      expect(update.rowCount).toBe(0);
      expect(deletion.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
    expect(
      (
        await t.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM plan_participant_introduction WHERE plan_id = $1`,
          [fixture.planId],
        )
      ).rows[0]?.count,
    ).toBeGreaterThan(0);
  });
});
