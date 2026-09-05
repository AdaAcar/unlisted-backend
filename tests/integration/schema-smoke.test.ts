import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';

import { freshDb, type TestDb } from './support/db';

/** Migrations apply cleanly on an empty database, and the basic shape is there. */

let t: TestDb;

beforeAll(async () => {
  t = await freshDb();
});

afterAll(async () => {
  await t?.close();
});

describe('migrations', () => {
  it('apply cleanly and create every entity table', async () => {
    const { rows } = await t.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = rows.map((r) => r.table_name).sort();

    expect(names).toEqual(
      [
        'application',
        'application_member',
        'audit_log',
        'block',
        'circle',
        'circle_member',
        'message',
        'message_thread',
        'plan',
        'plan_participant_introduction',
        'record',
        'session',
        'signal',
        'user',
        'venue',
      ].sort(),
    );
  });

  it('records the complete bootstrap stack through 0008', async () => {
    const { rows } = await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(rows[0]?.n).toBe(9);
  });

  it('hands the Drizzle ledger boundary to the migrator capability only', async () => {
    const ownership = await t.pool.query<{
      schema_owner: string;
      table_owner: string;
      sequence_owner: string;
      migrator_database_create: boolean;
    }>(
      `SELECT
         pg_get_userbyid(n.nspowner) AS schema_owner,
         pg_get_userbyid(c.relowner) AS table_owner,
         pg_get_userbyid(s.relowner) AS sequence_owner,
         has_database_privilege(
           'unlisted_migrator', current_database(), 'CREATE'
         ) AS migrator_database_create
       FROM pg_namespace n
       JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = '__drizzle_migrations'
       JOIN pg_class s ON s.oid = pg_get_serial_sequence(
         'drizzle.__drizzle_migrations', 'id'
       )::regclass
       WHERE n.nspname = 'drizzle'`,
    );
    expect(ownership.rows).toEqual([
      {
        schema_owner: 'unlisted_migrator',
        table_owner: 'unlisted_migrator',
        sequence_owner: 'unlisted_migrator',
        migrator_database_create: true,
      },
    ]);

    for (const role of ['public', 'unlisted_app', 'unlisted_admin']) {
      const privileges = await t.pool.query<{
        schema_access: boolean;
        table_access: boolean;
        sequence_access: boolean;
        database_create: boolean;
      }>(
        `SELECT
           has_database_privilege($1, current_database(), 'CREATE') AS database_create,
           has_schema_privilege($1, 'drizzle', 'USAGE') AS schema_access,
           has_table_privilege($1, 'drizzle.__drizzle_migrations',
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_access,
           has_sequence_privilege($1,
             pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id'),
             'USAGE,SELECT,UPDATE') AS sequence_access`,
        [role],
      );
      expect(privileges.rows[0]).toEqual({
        database_create: false,
        schema_access: false,
        table_access: false,
        sequence_access: false,
      });
    }
  });

  it('installs the viable-plan introduction ledger as append-only', async () => {
    const constraints = await t.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'plan_participant_introduction'::regclass
       ORDER BY conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        'plan_participant_introduction_id_ulid_chk',
        'plan_participant_introduction_plan_user_uq',
        'plan_participant_introduction_plan_viable_fk',
        'plan_participant_introduction_user_id_user_id_fk',
      ]),
    );

    const triggers = await t.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgrelid = 'plan_participant_introduction'::regclass
       ORDER BY tgname`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      'plan_participant_introduction_no_delete',
      'plan_participant_introduction_no_update',
    ]);
  });

  it('installs the generated columns and the guard triggers', async () => {
    const generated = await t.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'plan' AND is_generated = 'ALWAYS'
        ORDER BY column_name`,
    );
    expect(generated.rows.map((r) => r.column_name)).toEqual([
      'confirmed_total',
      'viable_plan_key',
    ]);

    const triggers = await t.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid = '"audit_log"'::regclass`,
    );
    expect(triggers.rows.map((r) => r.tgname).sort()).toEqual(
      ['audit_log_no_delete', 'audit_log_no_update'].sort(),
    );
  });
});

describe('append-only audit_log', () => {
  it('rejects UPDATE and DELETE', async () => {
    const userId = ulid();
    const rowId = ulid();
    await t.pool.query(`INSERT INTO "user" (id, first_name) VALUES ($1, 'A')`, [userId]);
    await t.pool.query(
      `INSERT INTO audit_log (id, actor_id, actor_role, action, resource_type, resource_id)
       VALUES ($1, $2, 'user', 'created', 'user', $2)`,
      [rowId, userId],
    );

    await expect(
      t.pool.query(`UPDATE audit_log SET action = 'tampered' WHERE id = $1`, [rowId]),
    ).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`DELETE FROM audit_log WHERE id = $1`, [rowId])).rejects.toThrow(
      /append-only/,
    );
  });

  it('requires a reason for moderator actions', async () => {
    await expect(
      t.pool.query(
        `INSERT INTO audit_log (id, actor_role, action, resource_type, resource_id)
         VALUES ($1, 'moderator', 'suspended', 'user', $2)`,
        [ulid(), ulid()],
      ),
    ).rejects.toThrow(/audit_log_moderator_reason_chk/);
  });
});

describe('identifier and DOB guarantees', () => {
  it('has no date-of-birth column anywhere', async () => {
    const { rows } = await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name ILIKE '%birth%' OR column_name ILIKE '%dob%'
               OR column_name ILIKE 'date_of_birth')`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('rejects a non-ULID primary key', async () => {
    await expect(
      t.pool.query(`INSERT INTO "user" (id, first_name) VALUES ('42', 'A')`),
    ).rejects.toThrow(/user_id_ulid_chk/);
  });
});
