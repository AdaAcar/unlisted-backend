import { sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAuditEntry } from '@/db/audit';
import { SYSTEM_ACTOR } from '@/db/scope/actor';
import { withActor } from '@/db/scope/scoped';

import { userActor } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;
let actorId: string;

beforeAll(async () => {
  t = await freshDb();
  actorId = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state) VALUES ($1, 'Actor', 'verified')`,
    [actorId],
  );
});

afterAll(async () => {
  await t?.close();
});

async function auditRowCount(resourceId: string): Promise<number> {
  const result = await t.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_log WHERE resource_id = $1`,
    [resourceId],
  );
  return result.rows[0]?.count ?? 0;
}

describe('audit log append path', () => {
  it('leaves zero rows when the caller transaction rolls back', async () => {
    const resourceId = ulid();
    const actor = userActor(actorId);

    await expect(
      withActor(actor, async (executor) => {
        await recordAuditEntry(executor, actor, {
          action: 'update_profile',
          actorRole: 'user',
          resourceId,
          resourceType: 'user',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await auditRowCount(resourceId)).toBe(0);
  });

  it('leaves exactly one row when the caller transaction commits', async () => {
    const resourceId = ulid();
    const actor = userActor(actorId);

    const id = await withActor(actor, (executor) =>
      recordAuditEntry(executor, actor, {
        action: 'update_profile',
        actorRole: 'user',
        afterState: { name: 'new' },
        beforeState: { name: 'old' },
        ipHash: 'a'.repeat(64),
        resourceId,
        resourceType: 'user',
        userAgentHash: 'b'.repeat(64),
      }),
    );

    expect(await auditRowCount(resourceId)).toBe(1);

    const rows = (await t.pool.query(`SELECT * FROM audit_log WHERE id = $1`, [id])).rows as {
      actor_id: string | null;
      actor_role: string;
      after_state: unknown;
      before_state: unknown;
      ip_hash: string | null;
      resource_id: string;
      user_agent_hash: string | null;
    }[];
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.actor_id).toBe(actorId);
    expect(row?.actor_role).toBe('user');
    expect(row?.resource_id).toBe(resourceId);
    expect(row?.before_state).toEqual({ name: 'old' });
    expect(row?.after_state).toEqual({ name: 'new' });
    expect(row?.ip_hash).toBe('a'.repeat(64));
    expect(row?.user_agent_hash).toBe('b'.repeat(64));
  });

  it('records a system actor entry with a null actor_id', async () => {
    const resourceId = ulid();

    const id = await withActor(SYSTEM_ACTOR, (executor) =>
      recordAuditEntry(executor, SYSTEM_ACTOR, {
        action: 'auto_cancel_plan',
        actorRole: 'system',
        resourceId,
        resourceType: 'plan',
      }),
    );

    const rows = (
      await t.pool.query(`SELECT actor_id, actor_role FROM audit_log WHERE id = $1`, [id])
    ).rows as { actor_id: string | null; actor_role: string }[];
    expect(rows[0]?.actor_id).toBeNull();
    expect(rows[0]?.actor_role).toBe('system');
  });

  it('rejects an actor forging a row attributed to a different actor id', async () => {
    const otherId = ulid();
    await t.pool.query(
      `INSERT INTO "user" (id, first_name, verification_state) VALUES ($1, 'Other', 'verified')`,
      [otherId],
    );
    const actor = userActor(actorId);

    await expect(
      withActor(actor, (executor) =>
        executor.execute(sql`
          INSERT INTO audit_log (id, actor_id, actor_role, action, resource_type, resource_id)
          VALUES (${ulid()}, ${otherId}, 'user', 'update_profile', 'user', ${ulid()})
        `),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it('rejects a user actor writing a null actor_id', async () => {
    const actor = userActor(actorId);

    await expect(
      withActor(actor, (executor) =>
        executor.execute(sql`
          INSERT INTO audit_log (id, actor_id, actor_role, action, resource_type, resource_id)
          VALUES (${ulid()}, NULL, 'user', 'update_profile', 'user', ${ulid()})
        `),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it('rejects a system actor writing a non-null actor_id', async () => {
    await expect(
      withActor(SYSTEM_ACTOR, (executor) =>
        executor.execute(sql`
          INSERT INTO audit_log (id, actor_id, actor_role, action, resource_type, resource_id)
          VALUES (${ulid()}, ${actorId}, 'system', 'auto_cancel_plan', 'plan', ${ulid()})
        `),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it('rejects a moderator action with no reason', async () => {
    const actor = userActor(actorId);

    await expect(
      withActor(actor, (executor) =>
        executor.execute(sql`
          INSERT INTO audit_log (id, actor_id, actor_role, action, resource_type, resource_id)
          VALUES (${ulid()}, ${actorId}, 'moderator', 'ban_user', 'user', ${ulid()})
        `),
      ),
    ).rejects.toThrow(/reason|check/i);
  });

  it('denies the app role SELECT on audit_log even after the write grant', async () => {
    const actor = userActor(actorId);

    await expect(
      withActor(actor, (executor) => executor.execute(sql`SELECT * FROM audit_log LIMIT 1`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('denies the app role UPDATE and DELETE on audit_log', async () => {
    const actor = userActor(actorId);

    await expect(
      withActor(actor, (executor) => executor.execute(sql`UPDATE audit_log SET action = 'x'`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withActor(actor, (executor) => executor.execute(sql`DELETE FROM audit_log`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('rejects UPDATE and DELETE even for the table owner, via the append-only triggers', async () => {
    // audit_log is owned by unlisted_migrator (0002_rls.sql) and FORCE ROW
    // LEVEL SECURITY applies RLS even to the owner — but unlisted_migrator has
    // no SELECT/UPDATE policy on audit_log at all, so `SET ROLE
    // unlisted_migrator` would make the row invisible and the UPDATE/DELETE
    // would silently match zero rows without ever reaching the trigger. That
    // would prove RLS denies visibility, not that the trigger blocks
    // mutation. Superusers bypass row security entirely regardless of FORCE
    // ROW LEVEL SECURITY, so running as the superuser test pool is what
    // actually lets the row be targeted and the trigger fire — proving no
    // role, privileged or not, can mutate an existing row.
    const seedId = ulid();
    await t.pool.query(
      `INSERT INTO audit_log (id, actor_id, actor_role, action, resource_type, resource_id)
       VALUES ($1, $2, 'user', 'seed', 'user', $3)`,
      [seedId, actorId, ulid()],
    );

    await expect(
      t.pool.query(`UPDATE audit_log SET action = 'x' WHERE id = $1`, [seedId]),
    ).rejects.toThrow(/append-only/i);
    await expect(t.pool.query(`DELETE FROM audit_log WHERE id = $1`, [seedId])).rejects.toThrow(
      /append-only/i,
    );
  });
});
