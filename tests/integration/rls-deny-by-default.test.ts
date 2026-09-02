import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requiredTestUrl, seedPublishedPlan, type PlanFixture } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;
let fixture: PlanFixture;

beforeAll(async () => {
  t = await freshDb();
  fixture = await seedPublishedPlan(t);
});

afterAll(async () => {
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
    expect(result.rows).toHaveLength(13);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('creates separated app and admin roles and revokes audit mutation', async () => {
    const roles = await t.pool.query<{ rolbypassrls: boolean; rolname: string }>(
      `SELECT rolname, rolbypassrls FROM pg_roles
       WHERE rolname IN ('unlisted_app', 'unlisted_admin', 'unlisted_migrator')`,
    );
    expect(roles.rows).toEqual(
      expect.arrayContaining([
        { rolname: 'unlisted_app', rolbypassrls: false },
        { rolname: 'unlisted_admin', rolbypassrls: true },
        { rolname: 'unlisted_migrator', rolbypassrls: false },
      ]),
    );
    const owners = await t.pool.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relowner) AS owner
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    );
    expect(owners.rows).toEqual([{ owner: 'unlisted_migrator' }]);
    const privileges = await t.pool.query<{ canDelete: boolean; canUpdate: boolean }>(
      `SELECT
         has_table_privilege('unlisted_app', 'audit_log', 'UPDATE') AS "canUpdate",
         has_table_privilege('unlisted_app', 'audit_log', 'DELETE') AS "canDelete"`,
    );
    expect(privileges.rows[0]).toEqual({ canUpdate: false, canDelete: false });
  });

  it('returns zero rows to the app role when the actor GUC is unset', async () => {
    const pool = new Pool({ connectionString: requiredTestUrl('APP_DATABASE_URL') });
    try {
      const result = await pool.query('SELECT id FROM plan');
      expect(result.rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('clears a transaction-local actor GUC before the same connection is reused', async () => {
    const pool = new Pool({
      connectionString: requiredTestUrl('APP_DATABASE_URL'),
      max: 1,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [fixture.actorId]);
      await client.query(`SELECT set_config('app.actor_standing', 'good', true)`);
      expect((await client.query('SELECT id FROM plan')).rows).toHaveLength(1);
      await client.query('COMMIT');
      expect((await client.query('SELECT id FROM plan')).rows).toEqual([]);
    } finally {
      client.release();
      await pool.end();
    }
  });
});
