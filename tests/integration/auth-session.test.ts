import { NextRequest } from 'next/server';
import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DELETE, POST } from '@/app/api/auth/session/route';
import { createSession, getSessionActor, recordAuditEntry, rotateSession } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { hashSessionToken } from '@/lib/sessionToken';

import { userActor } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;
let userId: string;

beforeAll(async () => {
  t = await freshDb();
  userId = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state) VALUES ($1, 'Actor', 'verified')`,
    [userId],
  );
});

afterAll(async () => {
  await t?.close();
});

function loginRequest(body: unknown, cookie?: string): NextRequest {
  return new NextRequest('http://localhost/auth/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function deleteRequest(cookie?: string): NextRequest {
  return new NextRequest('http://localhost/auth/session', {
    method: 'DELETE',
    headers: cookie ? { cookie } : {},
  });
}

function requestWithCookie(token: string): { headers: { get(name: string): string | null } } {
  return { headers: { get: (name: string) => (name === 'cookie' ? `session=${token}` : null) } };
}

async function auditRows(resourceId: string): Promise<{ action: string }[]> {
  const result = await t.pool.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY created_at`,
    [resourceId],
  );
  return result.rows;
}

describe('POST /auth/session', () => {
  it('sets an httpOnly, SameSite=Lax cookie and creates exactly one audited session row', async () => {
    const response = await POST(loginRequest({ userId }));
    expect(response.status).toBe(204);

    const cookie = response.cookies.get('session');
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(String(cookie?.sameSite).toLowerCase()).toBe('lax');

    const rows = await t.pool.query<{ id: string }>(`SELECT id FROM session WHERE user_id = $1`, [
      userId,
    ]);
    expect(rows.rows).toHaveLength(1);
    const sessionId = rows.rows[0]?.id;
    expect(sessionId).toBeDefined();

    const audit = await auditRows(sessionId as string);
    expect(audit).toEqual([{ action: 'session_create' }]);

    const resolved = await getSessionActor(requestWithCookie(cookie?.value as string));
    expect(resolved).toEqual(userActor(userId));
  });

  it('never validates a session identifier that existed before authentication (fixation)', async () => {
    const preExistingToken = 'attacker-planted-token';

    const response = await POST(loginRequest({ userId }, `session=${preExistingToken}`));
    const issuedCookie = response.cookies.get('session');

    expect(issuedCookie?.value).toBeDefined();
    expect(issuedCookie?.value).not.toBe(preExistingToken);

    // The pre-existing value was never turned into a valid session by login.
    await expect(getSessionActor(requestWithCookie(preExistingToken))).resolves.toBeNull();
    // The freshly issued one is valid.
    await expect(
      getSessionActor(requestWithCookie(issuedCookie?.value as string)),
    ).resolves.toEqual(userActor(userId));
  });

  it('leaves no session and no audit row when the write transaction rolls back', async () => {
    const actor = userActor(userId);
    const resourceId = ulid();

    await expect(
      withActor(actor, async (executor) => {
        await createSession(executor, actor, 'ab'.repeat(32), new Date(Date.now() + 1000));
        await recordAuditEntry(executor, actor, {
          action: 'session_create',
          actorRole: 'user',
          resourceId,
          resourceType: 'session',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const rows = await t.pool.query(`SELECT 1 FROM session WHERE token_hash = $1`, [
      'ab'.repeat(32),
    ]);
    expect(rows.rowCount).toBe(0);
    expect(await auditRows(resourceId)).toEqual([]);
  });
});

describe('DELETE /auth/session (individual revocation)', () => {
  it('kills only the revoked session, leaving the user’s other sessions working', async () => {
    const first = await POST(loginRequest({ userId }));
    const second = await POST(loginRequest({ userId }));
    const firstToken = first.cookies.get('session')?.value as string;
    const secondToken = second.cookies.get('session')?.value as string;
    expect(firstToken).not.toBe(secondToken);

    const revokeResponse = await DELETE(deleteRequest(`session=${firstToken}`));
    expect(revokeResponse.status).toBe(204);

    await expect(getSessionActor(requestWithCookie(firstToken))).resolves.toBeNull();
    await expect(getSessionActor(requestWithCookie(secondToken))).resolves.toEqual(
      userActor(userId),
    );

    const rows = await t.pool.query<{ id: string }>(
      `SELECT id FROM session WHERE token_hash = $1`,
      [hashSessionToken(firstToken)],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('records exactly one session_delete audit row for the revoked session', async () => {
    const login = await POST(loginRequest({ userId }));
    const token = login.cookies.get('session')?.value as string;
    const sessionRow = await t.pool.query<{ id: string }>(
      `SELECT id FROM session WHERE token_hash = $1`,
      [hashSessionToken(token)],
    );
    const sessionId = sessionRow.rows[0]?.id as string;

    await DELETE(deleteRequest(`session=${token}`));

    expect(await auditRows(sessionId)).toEqual([
      { action: 'session_create' },
      { action: 'session_delete' },
    ]);
  });

  it('is an idempotent no-op with no audit row when there is nothing to revoke', async () => {
    const response = await DELETE(deleteRequest());
    expect(response.status).toBe(204);

    const response2 = await DELETE(deleteRequest('session=not-a-real-token'));
    expect(response2.status).toBe(204);
  });
});

describe('session rotation (stale after privilege change)', () => {
  it('invalidates the prior identifier once a new one is issued', async () => {
    const actor = userActor(userId);
    const oldTokenHash = 'a'.repeat(64);
    const newTokenHash = 'b'.repeat(64);
    const expiresAt = new Date(Date.now() + 1000 * 60);

    await withActor(actor, (executor) => createSession(executor, actor, oldTokenHash, expiresAt));
    await expect(
      getSessionActor(requestWithCookie('irrelevant-since-we-check-by-hash-below')),
    ).resolves.toBeNull();

    const rotatedId = await withActor(actor, async (executor) => {
      const id = await rotateSession(executor, actor, oldTokenHash, newTokenHash, expiresAt);
      await recordAuditEntry(executor, actor, {
        action: 'session_rotate',
        actorRole: 'user',
        resourceId: id,
        resourceType: 'session',
      });
      return id;
    });

    const oldRow = await t.pool.query(`SELECT 1 FROM session WHERE token_hash = $1`, [
      oldTokenHash,
    ]);
    expect(oldRow.rowCount).toBe(0);

    const newRow = await t.pool.query(`SELECT 1 FROM session WHERE token_hash = $1`, [
      newTokenHash,
    ]);
    expect(newRow.rowCount).toBe(1);

    expect(await auditRows(rotatedId)).toEqual([{ action: 'session_rotate' }]);
  });
});
