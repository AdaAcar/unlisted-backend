import { NextRequest } from 'next/server';
import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as recover } from '@/app/api/auth/recover/route';
import { POST as createSessionRoute } from '@/app/api/auth/session/route';

import { freshDb, type TestDb } from './support/db';

let t: TestDb;
let bannedUserId: string;

beforeAll(async () => {
  t = await freshDb();
  bannedUserId = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state, standing) VALUES ($1, 'Banned', 'verified', 'banned')`,
    [bannedUserId],
  );
});

afterAll(async () => {
  await t?.close();
});

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<unknown> {
  return response.json();
}

describe('POST /auth/session enumeration resistance', () => {
  it('responds byte-identically for a banned (existing) account and a non-existent one', async () => {
    const nonExistentId = ulid();

    const existingButBanned = await createSessionRoute(
      jsonRequest('http://localhost/auth/session', { userId: bannedUserId }),
    );
    const nonExistent = await createSessionRoute(
      jsonRequest('http://localhost/auth/session', { userId: nonExistentId }),
    );

    expect(existingButBanned.status).toBe(nonExistent.status);
    expect(existingButBanned.status).toBe(401);
    expect(await bodyOf(existingButBanned)).toEqual(await bodyOf(nonExistent));
    expect(existingButBanned.cookies.get('session')).toBeUndefined();
    expect(nonExistent.cookies.get('session')).toBeUndefined();
  });
});

describe('POST /auth/recover', () => {
  it('always returns success regardless of account existence', async () => {
    const forExisting = await recover(
      jsonRequest('http://localhost/auth/recover', { identifier: bannedUserId }),
    );
    const forNonExistent = await recover(
      jsonRequest('http://localhost/auth/recover', { identifier: ulid() }),
    );

    const existingBody = await bodyOf(forExisting);
    const nonExistentBody = await bodyOf(forNonExistent);

    expect(forExisting.status).toBe(200);
    expect(forNonExistent.status).toBe(200);
    expect(existingBody).toEqual(nonExistentBody);
    expect(existingBody).toEqual({ ok: true });
  });
});
