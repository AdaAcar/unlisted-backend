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
    expect(result.rows).toHaveLength(15);
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
      // C3 (0011) gave unlisted_app a column-scoped plan UPDATE on the
      // lifecycle columns only; host_circle_id is still not in any grant, so a
      // raw attempt to move a plan's host is a hard privilege error, and DELETE
      // is ungranted too.
      await attempt(`UPDATE plan SET host_circle_id = $1 WHERE id = $2`, [
        fixture.circleId,
        fixture.planId,
      ]);
      await attempt(`DELETE FROM plan WHERE id = $1`, [fixture.planId]);
      // C7a (0013) DID grant unlisted_app a column-scoped UPDATE on
      // accepted_guest_count / held_count — so this is no longer a privilege
      // error. It is instead an RLS no-op: fixture.actorId is neither the host
      // lead nor a party to an invited/accepted application, so
      // plan_app_capacity_update matches zero rows.
      {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE unlisted_app');
          await client.query(`SELECT set_config('app.actor_id', $1, true)`, [fixture.actorId]);
          const res = await client.query(
            `UPDATE plan SET accepted_guest_count = 99 WHERE id = $1`,
            [fixture.planId],
          );
          expect(res.rowCount).toBe(0);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
      expect(
        (await t.pool.query(`SELECT note FROM plan WHERE id = $1`, [fixture.planId])).rows[0],
      ).toEqual({ note: null });
    } finally {
      await pool.end();
    }
  });

  it('lets the app role touch a granted plan column only through the lead RLS policy (0011)', async () => {
    const pool = new Pool({ connectionString: appLoginUrl });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE unlisted_app');
        // fixture.actorId is a plain user, not the host circle's lead.
        await client.query(`SELECT set_config('app.actor_id', $1, true)`, [fixture.actorId]);
        const res = await client.query(`UPDATE plan SET note = 'tampered' WHERE id = $1`, [
          fixture.planId,
        ]);
        expect(res.rowCount).toBe(0); // plan_app_update USING app_actor_leads_circle -> no row
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
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
        // C8 (0012): the participant_count resync trigger runs as migrator and
        // needs SELECT (to find the thread) + UPDATE (to set the count) on
        // message_thread, which is FORCE-RLS with no other migrator policy.
        ['message_thread_migrator_participant_count', 'message_thread', 'UPDATE'],
        ['message_thread_migrator_read', 'message_thread', 'SELECT'],
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
           'app_actor_leads_circle',
           'app_active_host_member_count',
           'app_thread_participant',
           'app_actor_is_application_party',
           'app_actor_has_capacity_stake_in_plan',
           'app_user_has_overlapping_accepted_plan',
           'app_plan_guest_circle_ids',
           'enforce_plan_capacity_scope',
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
      'app_actor_leads_circle(counterparty_circle_id character varying)',
      'app_active_host_member_count(counterparty_circle_id character varying)',
      'app_thread_participant(counterparty_plan_id character varying)',
      'app_shared_introduction_visible(subject_user_id character varying)',
      // C5/C7a (0013): policy predicates for the application write surface and
      // the plan capacity-update policy, plus the overlap check.
      'app_actor_is_application_party(counterparty_application_id character varying)',
      'app_actor_has_capacity_stake_in_plan(counterparty_plan_id character varying)',
      'app_user_has_overlapping_accepted_plan(subject_user_id character varying, window_start timestamp with time zone, window_end timestamp with time zone, exclude_application_id character varying)',
      // C7c fix (0015): the guest-circle read for Decision C's plans_attended
      // counter — SECURITY DEFINER so E1's SYSTEM_ACTOR caller is not scoped out.
      'app_plan_guest_circle_ids(target_plan_id character varying)',
    ]);
    const adminFunctions = new Set([
      'app_current_actor_id()',
      'app_actor_present()',
      'app_user_visible(counterparty_user_id character varying)',
      'app_circle_visible(counterparty_circle_id character varying)',
      'app_plan_visible(counterparty_plan_id character varying)',
      'app_application_visible(counterparty_application_id character varying)',
      'app_actor_hosts_circle(counterparty_circle_id character varying)',
      'app_actor_leads_circle(counterparty_circle_id character varying)',
      // app_active_host_member_count is NOT here: C8 (0012) moved it to
      // unlisted_migrator ownership (see docs/state.md Known gaps C3), which
      // drops the old owner's admin EXECUTE grant. Nothing admin-side calls it.
      // C5/C7a (0013): owned by unlisted_admin like the other actor-scope
      // predicates, so admin holds EXECUTE (SECURITY DEFINER runs as owner).
      'app_actor_is_application_party(counterparty_application_id character varying)',
      'app_actor_has_capacity_stake_in_plan(counterparty_plan_id character varying)',
      'app_user_has_overlapping_accepted_plan(subject_user_id character varying, window_start timestamp with time zone, window_end timestamp with time zone, exclude_application_id character varying)',
      // C7c fix (0015): owned by unlisted_admin, so admin holds EXECUTE via
      // ownership even though only unlisted_app gets an explicit GRANT.
      'app_plan_guest_circle_ids(target_plan_id character varying)',
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
    expect(functions.rows).toHaveLength(22);
  });

  it('grants app and admin exactly the six-table SELECT surface, plus the app-only audit_log INSERT, the session grants (B1), the verification column grants (B2), and the app-only circle read + circle/circle_member write grants (C1), and no other mutations', async () => {
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
    ]);
    // audit_log INSERT (0006_audit_append.sql, A4) and the session table's
    // SELECT/INSERT/DELETE (0007_session.sql, B1) are the deliberate
    // exceptions beyond the six-table read surface: audit_log is
    // unlisted_app-only, INSERT-only, no SELECT — the app writes audit rows
    // and can never read them back. session is unlisted_app SELECT+INSERT+
    // DELETE (no UPDATE; see 0007's comment) and unlisted_admin SELECT-only
    // (the pre-authentication token lookup).
    //
    // "user" is its own case, deliberately not in `allowed`: 0008_verification.sql
    // (B2) revoked the table-wide SELECT grant both roles held and replaced
    // it with an explicit column list that omits identity_hash and
    // verification_ref (unlisted_app keeps verification_ref, needed for the
    // webhook's WHERE clause). `has_table_privilege` only sees table-wide
    // grants, not column-level ones — since neither role holds a table-wide
    // SELECT on "user" anymore, `has_table_privilege(..., 'SELECT')` is
    // correctly false for both here even though most columns remain
    // selectable; the dedicated column-privilege test below is what proves
    // the actual column-level shape. Likewise unlisted_app's column-scoped
    // UPDATE (exactly verification_state/age/identity_hash/verification_ref)
    // doesn't register as table-wide `canUpdate` either.
    //
    // C1 (0009_circle_access.sql): unlisted_app alone gets SELECT + INSERT on
    // `circle` (members-only read, creation) and INSERT on `circle_member`
    // (invite / the creator's own lead row); its UPDATE on both is
    // column-scoped (circle.lead_user_id; circle_member.role/status/
    // joined_at/removed_at), so — like B2's verification UPDATE — it does not
    // register as table-wide `canUpdate`. unlisted_admin gets nothing new:
    // no admin path needs `circle`.
    //
    // C2 (0010_venue_read.sql): unlisted_app alone gets a column-scoped
    // SELECT on venue's six public columns (licence_ref / capacity_hint
    // omitted). Same as "user": `has_table_privilege(..., 'SELECT')` is
    // false because there is no table-wide grant; the column-privilege test
    // below proves the real shape. Read-only — no INSERT/UPDATE/DELETE.
    for (const row of privileges.rows) {
      const isAppAuditInsert = row.grantee === 'unlisted_app' && row.tableName === 'audit_log';
      const isSession = row.tableName === 'session';
      const isAppSessionRW = row.grantee === 'unlisted_app' && isSession;
      const isColumnScopedSelect = row.tableName === 'user' || row.tableName === 'venue';
      const isApp = row.grantee === 'unlisted_app';
      const isAppCircle = isApp && row.tableName === 'circle';
      const isAppCircleMemberInsert = isApp && row.tableName === 'circle_member';
      // C3 (0011): unlisted_app alone gets a table-wide INSERT on `plan`
      // (draft creation) and a column-scoped UPDATE (the lifecycle columns —
      // host_circle_id and the guest counters excluded), which — like the B2 /
      // C1 column-scoped grants — does not register as table-wide `canUpdate`.
      const isAppPlanInsert = isApp && row.tableName === 'plan';
      // C5/C6/C7a (0013): unlisted_app gets table-wide INSERT on `application`
      // and `application_member` (create an application; compose the circle),
      // plus DELETE on `application_member` (withdraw-member). Its UPDATE on
      // both is column-scoped (application: state/note/response_deadline/
      // submitted_at/decided_at/withdrawn_at; application_member: confirmation
      // /invitation columns), and plan's two new capacity counters are also
      // column-scoped — none register as table-wide `canUpdate`.
      const isAppApplicationInsert =
        isApp && (row.tableName === 'application' || row.tableName === 'application_member');
      const isAppApplicationMemberDelete = isApp && row.tableName === 'application_member';
      // C8 (0012): unlisted_app gets table-wide SELECT + INSERT on message_thread
      // and message (read a thread you participate in; create one / post into
      // it — all further gated by RLS). No UPDATE / DELETE — participant_count
      // is trigger-maintained and retention is E2.
      const isAppMessaging =
        isApp && (row.tableName === 'message' || row.tableName === 'message_thread');

      expect(row.canSelect).toBe(
        isColumnScopedSelect
          ? false
          : allowed.has(row.tableName) || isSession || isAppCircle || isAppMessaging,
      );
      expect(row.canInsert).toBe(
        isAppAuditInsert ||
          isAppSessionRW ||
          isAppCircle ||
          isAppCircleMemberInsert ||
          isAppPlanInsert ||
          isAppMessaging ||
          isAppApplicationInsert,
      );
      expect(row.canUpdate).toBe(false);
      expect(row.canDelete).toBe(isAppSessionRW || isAppApplicationMemberDelete);
      expect(row.canTruncate).toBe(false);
      expect(row.canReferences).toBe(false);
      expect(row.canTrigger).toBe(false);
    }
  });

  it('column-scopes the verification write to exactly four columns, and denies identity_hash/verification_ref SELECT except the one WHERE-clause exception (B2)', async () => {
    const deniedChecks: [
      role: 'unlisted_app' | 'unlisted_admin',
      column: string,
      privilege: 'SELECT' | 'UPDATE',
    ][] = [
      ['unlisted_app', 'identity_hash', 'SELECT'],
      ['unlisted_admin', 'identity_hash', 'SELECT'],
      ['unlisted_admin', 'verification_ref', 'SELECT'],
      ['unlisted_admin', 'verification_state', 'UPDATE'],
      ['unlisted_admin', 'age', 'UPDATE'],
      ['unlisted_admin', 'identity_hash', 'UPDATE'],
      ['unlisted_admin', 'verification_ref', 'UPDATE'],
    ];
    for (const [role, column, privilege] of deniedChecks) {
      const result = await t.pool.query<{ has: boolean }>(
        `SELECT has_column_privilege($1, 'public."user"', $2, $3) AS has`,
        [role, column, privilege],
      );
      expect(result.rows[0]?.has, `${role} ${privilege} ${column}`).toBe(false);
    }

    const grantedChecks: [string, 'SELECT' | 'UPDATE'][] = [
      ['verification_ref', 'SELECT'],
      ['verification_state', 'UPDATE'],
      ['age', 'UPDATE'],
      ['identity_hash', 'UPDATE'],
      ['verification_ref', 'UPDATE'],
    ];
    for (const [column, privilege] of grantedChecks) {
      const result = await t.pool.query<{ has: boolean }>(
        `SELECT has_column_privilege('unlisted_app', 'public."user"', $1, $2) AS has`,
        [column, privilege],
      );
      expect(result.rows[0]?.has, `unlisted_app ${privilege} ${column}`).toBe(true);
    }

    // Nobody ever gets UPDATE on an ordinary column through this grant.
    const firstNameUpdate = await t.pool.query<{ has: boolean }>(
      `SELECT has_column_privilege('unlisted_app', 'public."user"', 'first_name', 'UPDATE') AS has`,
    );
    expect(firstNameUpdate.rows[0]?.has).toBe(false);
  });

  it('column-scopes the circle record-counter write to exactly plans_hosted / plans_attended (C7c)', async () => {
    // 0014: completePlan banks plans_hosted (host circle) and plans_attended
    // (each distinct guest circle) as a system actor. The grant is exactly
    // those two columns — no_shows / late_declines stay signal-class and
    // un-grantable, and it is not a table-wide UPDATE.
    for (const column of ['plans_hosted', 'plans_attended']) {
      const granted = await t.pool.query<{ has: boolean }>(
        `SELECT has_column_privilege('unlisted_app', 'public.circle', $1, 'UPDATE') AS has`,
        [column],
      );
      expect(granted.rows[0]?.has, column).toBe(true);
    }
    for (const column of ['no_shows', 'late_declines', 'name']) {
      const denied = await t.pool.query<{ has: boolean }>(
        `SELECT has_column_privilege('unlisted_app', 'public.circle', $1, 'UPDATE') AS has`,
        [column],
      );
      expect(denied.rows[0]?.has, column).toBe(false);
    }
    const tableWide = await t.pool.query<{ has: boolean }>(
      `SELECT has_table_privilege('unlisted_app', 'public.circle', 'UPDATE') AS has`,
    );
    expect(tableWide.rows[0]?.has).toBe(false);
    const adminAny = await t.pool.query<{ has: boolean }>(
      `SELECT has_column_privilege('unlisted_admin', 'public.circle', 'plans_hosted', 'UPDATE') AS has`,
    );
    expect(adminAny.rows[0]?.has).toBe(false);
  });

  it('gives admin exactly seven forced-RLS cross-actor SELECT policies', async () => {
    const policies = await t.pool.query<{ cmd: string; tablename: string }>(
      `SELECT tablename, cmd FROM pg_policies
       WHERE schemaname = 'public' AND 'unlisted_admin' = ANY(roles)
       ORDER BY tablename`,
    );
    expect(policies.rows).toEqual(
      [
        'application',
        'application_member',
        'block',
        'circle_member',
        'plan',
        'session',
        'user',
      ].map((tablename) => ({ cmd: 'SELECT', tablename })),
    );
  });

  it('gives the application capability exactly six scoped SELECT policies, plus the audit_log append policy, the session policies (B1), the verification write policy (B2), the circle / circle_member read+write policies (C1), the venue read policy (C2), the plan write policies (C3), the message_thread / message read+create policies (C8), and the application / application_member write policies plus the plan capacity-update policy (C5/C6/C7a)', async () => {
    const policies = await t.pool.query<{ cmd: string; tablename: string }>(
      `SELECT tablename, cmd FROM pg_policies
       WHERE schemaname = 'public' AND 'unlisted_app' = ANY(roles)
       ORDER BY tablename, cmd`,
    );
    expect(policies.rows).toEqual([
      // application: 0004 read + 0013 (C5) insert/update.
      { cmd: 'INSERT', tablename: 'application' },
      { cmd: 'SELECT', tablename: 'application' },
      { cmd: 'UPDATE', tablename: 'application' },
      // application_member: 0004 read + 0013 (C5) delete/insert/update.
      { cmd: 'DELETE', tablename: 'application_member' },
      { cmd: 'INSERT', tablename: 'application_member' },
      { cmd: 'SELECT', tablename: 'application_member' },
      { cmd: 'UPDATE', tablename: 'application_member' },
      { cmd: 'INSERT', tablename: 'audit_log' },
      { cmd: 'SELECT', tablename: 'block' },
      // circle: 0009's insert + members-only read + lead-only update, plus
      // 0014's system-actor read/write pair (completePlan banks the record
      // counters as a system actor — C7c Decision C).
      { cmd: 'INSERT', tablename: 'circle' },
      { cmd: 'SELECT', tablename: 'circle' },
      { cmd: 'SELECT', tablename: 'circle' },
      { cmd: 'UPDATE', tablename: 'circle' },
      { cmd: 'UPDATE', tablename: 'circle' },
      { cmd: 'INSERT', tablename: 'circle_member' },
      // 0004's `circle_member_app_read` plus 0009's additive
      // `circle_member_app_roster_read` (per-member roster view).
      { cmd: 'SELECT', tablename: 'circle_member' },
      { cmd: 'SELECT', tablename: 'circle_member' },
      { cmd: 'UPDATE', tablename: 'circle_member' },
      // C8 (0012): read a message you may see; post one as yourself.
      { cmd: 'INSERT', tablename: 'message' },
      { cmd: 'SELECT', tablename: 'message' },
      // C8 (0012): read a thread you participate in; create one where you do.
      { cmd: 'INSERT', tablename: 'message_thread' },
      { cmd: 'SELECT', tablename: 'message_thread' },
      // 0004's `plan_app_read` plus 0011's `plan_app_insert` / `plan_app_update`
      // (C3 — draft creation and lifecycle writes, lead-gated) plus 0013's
      // `plan_app_capacity_update` (C7a — the invitee's guest-counter write,
      // confined to the counter columns by plan_enforce_capacity_scope).
      { cmd: 'INSERT', tablename: 'plan' },
      { cmd: 'SELECT', tablename: 'plan' },
      { cmd: 'UPDATE', tablename: 'plan' },
      { cmd: 'UPDATE', tablename: 'plan' },
      { cmd: 'DELETE', tablename: 'session' },
      { cmd: 'INSERT', tablename: 'session' },
      { cmd: 'SELECT', tablename: 'session' },
      { cmd: 'SELECT', tablename: 'user' },
      { cmd: 'UPDATE', tablename: 'user' },
      { cmd: 'SELECT', tablename: 'venue' },
    ]);
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
      // accepted_guest_count = 1 satisfies the Decision B set-time floor (C7c);
      // the ledger still populates from the one real host member.
      `UPDATE plan SET confirmed_host_count = 3, accepted_guest_count = 1, viable_at = now() WHERE id = $1`,
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
