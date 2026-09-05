import { createHmac } from 'node:crypto';

import { NextRequest } from 'next/server';
import { ulid } from 'ulidx';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as loginPost } from '@/app/api/auth/session/route';
import { POST as startPost } from '@/app/api/verification/start/route';
import { POST as webhookPost } from '@/app/api/verification/webhook/route';
import { completeVerification, recordAuditEntry, startVerification } from '@/db';
import { SYSTEM_ACTOR } from '@/db/scope/actor';
import { withActor } from '@/db/scope/scoped';

import { freshDb, type TestDb } from './support/db';

const WEBHOOK_SECRET = 'w'.repeat(32);

let t: TestDb;

beforeAll(async () => {
  process.env.VERIFICATION_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.IDENTITY_HASH_SECRET = 'i'.repeat(32);
  t = await freshDb();
});

afterAll(async () => {
  await t?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function webhookRequest(
  bodyObject: unknown,
  options: { signature?: string | null } = {},
): NextRequest {
  const body = JSON.stringify(bodyObject);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const signature = options.signature === undefined ? sign(body) : options.signature;
  if (signature !== null) headers['x-verification-signature'] = signature;
  return new NextRequest('http://localhost/verification/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

function startRequest(cookie?: string): NextRequest {
  return new NextRequest('http://localhost/verification/start', {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  });
}

async function createUserAndLogin(): Promise<{ userId: string; cookie: string }> {
  const userId = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state) VALUES ($1, 'A', 'none')`,
    [userId],
  );
  const loginResponse = await loginPost(
    new NextRequest('http://localhost/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }),
  );
  const cookie = `session=${loginResponse.cookies.get('session')?.value}`;
  return { userId, cookie };
}

async function userRow(userId: string): Promise<{
  verification_state: string;
  age: number | null;
  identity_hash: string | null;
  verification_ref: string | null;
}> {
  const result = await t.pool.query(
    `SELECT verification_state, age, identity_hash, verification_ref FROM "user" WHERE id = $1`,
    [userId],
  );
  return result.rows[0];
}

async function auditActions(resourceId: string): Promise<string[]> {
  const result = await t.pool.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY created_at`,
    [resourceId],
  );
  return result.rows.map((row) => row.action);
}

describe('POST /verification/start', () => {
  it('returns a vendor session and marks the user pending', async () => {
    const { userId, cookie } = await createUserAndLogin();
    const response = await startPost(startRequest(cookie));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { vendorSessionRef: string };
    expect(typeof body.vendorSessionRef).toBe('string');
    expect(body.vendorSessionRef.length).toBeGreaterThan(0);

    const row = await userRow(userId);
    expect(row.verification_state).toBe('pending');
    expect(row.verification_ref).toBe(body.vendorSessionRef);

    expect(await auditActions(userId)).toContain('verification_start');
  });

  it('denies an unauthenticated caller', async () => {
    const response = await startPost(startRequest());
    expect(response.status).toBe(401);
  });
});

describe('POST /verification/webhook', () => {
  it('rejects an unsigned webhook before ever parsing the body', async () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    const response = await webhookPost(
      webhookRequest(
        { vendorSessionRef: 'irrelevant', verificationState: 'failed' },
        { signature: null },
      ),
    );
    expect(response.status).toBe(401);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('rejects a wrong signature identically to an unsigned one', async () => {
    const payload = { vendorSessionRef: 'irrelevant', verificationState: 'failed' as const };
    const unsigned = await webhookPost(webhookRequest(payload, { signature: null }));
    const unsignedBody = await unsigned.json();

    const wrongSignature = await webhookPost(
      webhookRequest(payload, { signature: 'f'.repeat(64) }),
    );
    const wrongSignatureBody = await wrongSignature.json();

    expect(wrongSignature.status).toBe(unsigned.status);
    expect(wrongSignatureBody).toEqual(unsignedBody);
  });

  it('never parses the body when the signature is wrong, same as when it is missing', async () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    await webhookPost(
      webhookRequest(
        { vendorSessionRef: 'irrelevant', verificationState: 'failed' },
        { signature: 'f'.repeat(64) },
      ),
    );
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('sets verification_state, age, and identity_hash on a valid webhook, and consumes the session ref', async () => {
    const { userId, cookie } = await createUserAndLogin();
    const startResponse = await startPost(startRequest(cookie));
    const { vendorSessionRef } = (await startResponse.json()) as { vendorSessionRef: string };

    const response = await webhookPost(
      webhookRequest({
        vendorSessionRef,
        verificationState: 'verified',
        age: 25,
        identityReference: 'vendor-identity-A',
      }),
    );
    expect(response.status).toBe(204);

    const row = await userRow(userId);
    expect(row.verification_state).toBe('verified');
    expect(row.age).toBe(25);
    expect(row.identity_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.identity_hash).not.toContain('vendor-identity-A');
    expect(row.verification_ref).toBeNull();

    expect(await auditActions(userId)).toEqual(['verification_start', 'verification_complete']);
  });

  it("does not clear an already-verified user's age/identity_hash on a later failed attempt", async () => {
    const { userId, cookie } = await createUserAndLogin();
    const firstStart = await startPost(startRequest(cookie));
    const { vendorSessionRef: firstRef } = (await firstStart.json()) as {
      vendorSessionRef: string;
    };
    await webhookPost(
      webhookRequest({
        vendorSessionRef: firstRef,
        verificationState: 'verified',
        age: 28,
        identityReference: 'vendor-identity-repeat',
      }),
    );
    const verifiedRow = await userRow(userId);

    const secondStart = await startPost(startRequest(cookie));
    const { vendorSessionRef: secondRef } = (await secondStart.json()) as {
      vendorSessionRef: string;
    };
    const response = await webhookPost(
      webhookRequest({ vendorSessionRef: secondRef, verificationState: 'failed' }),
    );
    expect(response.status).toBe(204);

    const afterFailedRow = await userRow(userId);
    expect(afterFailedRow.verification_state).toBe('failed');
    expect(afterFailedRow.age).toBe(verifiedRow.age);
    expect(afterFailedRow.identity_hash).toBe(verifiedRow.identity_hash);
  });

  it('rejects a webhook for a session ref that does not exist, generically', async () => {
    const response = await webhookPost(
      webhookRequest({
        vendorSessionRef: 'no-such-session',
        verificationState: 'verified',
        age: 25,
        identityReference: 'vendor-identity-nowhere',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('blocks a second account with a colliding identity_hash, surfaced as the same generic failure', async () => {
    const first = await createUserAndLogin();
    const firstStart = await startPost(startRequest(first.cookie));
    const { vendorSessionRef: firstRef } = (await firstStart.json()) as {
      vendorSessionRef: string;
    };
    const firstWebhook = await webhookPost(
      webhookRequest({
        vendorSessionRef: firstRef,
        verificationState: 'verified',
        age: 30,
        identityReference: 'shared-identity',
      }),
    );
    expect(firstWebhook.status).toBe(204);

    const second = await createUserAndLogin();
    const secondStart = await startPost(startRequest(second.cookie));
    const { vendorSessionRef: secondRef } = (await secondStart.json()) as {
      vendorSessionRef: string;
    };
    const secondWebhook = await webhookPost(
      webhookRequest({
        vendorSessionRef: secondRef,
        verificationState: 'verified',
        age: 22,
        identityReference: 'shared-identity',
      }),
    );

    // Same status/body shape as the "no matching session" case above -- the
    // caller cannot tell a collision from a bad ref.
    expect(secondWebhook.status).toBe(400);
    expect(await secondWebhook.json()).toEqual(
      await (
        await webhookPost(
          webhookRequest({ vendorSessionRef: 'no-such-session', verificationState: 'failed' }),
        )
      ).json(),
    );

    const secondRow = await userRow(second.userId);
    expect(secondRow.verification_state).toBe('pending');
    expect(secondRow.identity_hash).toBeNull();
    expect(await auditActions(second.userId)).toEqual(['verification_start']);
  });

  it('never has anywhere to persist a document, on any path', async () => {
    const documentColumns = await t.pool.query<{ column_name: string; table_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (column_name ILIKE '%document%' OR column_name ILIKE '%file%'
              OR column_name ILIKE '%scan%' OR column_name ILIKE '%upload%')`,
    );
    expect(documentColumns.rows).toEqual([]);

    // Even a payload that tries to smuggle one in is silently stripped by
    // zod's default field-stripping (`webhookBodySchema` in
    // lib/verificationVendor.ts declares no such field, and does not use
    // `.passthrough()`), so it never reaches db/verification.ts at all.
    const { userId, cookie } = await createUserAndLogin();
    const startResponse = await startPost(startRequest(cookie));
    const { vendorSessionRef } = (await startResponse.json()) as { vendorSessionRef: string };

    await webhookPost(
      webhookRequest({
        vendorSessionRef,
        verificationState: 'verified',
        age: 25,
        identityReference: 'vendor-identity-B',
        documentBase64: 'this-must-never-be-stored-anywhere',
      }),
    );

    const row = await t.pool.query(`SELECT * FROM "user" WHERE id = $1`, [userId]);
    expect(JSON.stringify(row.rows[0])).not.toContain('this-must-never-be-stored-anywhere');
  });

  it('leaves no state change and no audit row when the write transaction rolls back', async () => {
    const { userId } = await createUserAndLogin();
    // Seeded through the system-actor path, not a raw pool query: migration
    // 0008's trigger rejects a change to verification_ref from any
    // connection without a system-labeled actor GUC, superuser included.
    await withActor(SYSTEM_ACTOR, (executor) =>
      startVerification(executor, userId, 'rollback-ref'),
    );

    await expect(
      withActor(SYSTEM_ACTOR, async (executor) => {
        const matchedUserId = await completeVerification(executor, {
          vendorSessionRef: 'rollback-ref',
          verificationState: 'verified',
          age: 40,
          identityHash: 'a'.repeat(64),
        });
        await recordAuditEntry(executor, SYSTEM_ACTOR, {
          action: 'verification_complete',
          actorRole: 'system',
          resourceId: matchedUserId as string,
          resourceType: 'user',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const row = await userRow(userId);
    expect(row.verification_state).toBe('pending');
    expect(row.verification_ref).toBe('rollback-ref');
    // The seed write above calls startVerification directly, not through
    // the route, so it never records its own audit entry (only real
    // callers of recordAuditEntry get one) -- the rolled-back transaction's
    // verification_complete entry is the only one that could have existed,
    // and it must not have.
    expect(await auditActions(userId)).toEqual([]);
  });
});
