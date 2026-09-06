import { NextRequest } from 'next/server';
import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as listVenuesRoute } from '@/app/api/venues/route';
import { GET as getVenueRoute } from '@/app/api/venues/[id]/route';
import { generateSessionToken, hashSessionToken } from '@/lib/sessionToken';

import { freshDb, type TestDb } from './support/db';

let t: TestDb;
let cookie: string;

const PUBLIC_KEYS = ['id', 'name', 'address', 'district', 'type', 'operatorVerified'].sort();
const INTERNAL_KEYS = ['licenceRef', 'capacityHint', 'licence_ref', 'capacity_hint'];

async function seedVenue(over: {
  name?: string;
  district?: string;
  type?: string;
}): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO venue (id, name, address, district, type, operator_verified, licence_ref, capacity_hint)
     VALUES ($1, $2, 'Public address', $3, $4, true, 'LIC-SECRET', 42)`,
    [id, over.name ?? 'Venue', over.district ?? 'Kadikoy', over.type ?? 'bar'],
  );
  return id;
}

beforeAll(async () => {
  t = await freshDb();
  const userId = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state) VALUES ($1, 'U', 'verified')`,
    [userId],
  );
  const token = generateSessionToken();
  await t.pool.query(
    `INSERT INTO session (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [ulid(), userId, hashSessionToken(token)],
  );
  cookie = `session=${token}`;
});

afterAll(async () => {
  await t?.close();
});

function req(path: string, withCookie = true): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: withCookie ? { cookie } : {},
  });
}

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /venues', () => {
  it('returns the registry with only public fields serialized', async () => {
    await seedVenue({ name: 'Bar One' });
    const res = await listVenuesRoute(req('/venues'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { venues: Record<string, unknown>[] };
    expect(body.venues.length).toBeGreaterThan(0);
    for (const v of body.venues) {
      expect(Object.keys(v).sort()).toEqual(PUBLIC_KEYS);
      for (const k of INTERNAL_KEYS) expect(k in v).toBe(false);
    }
  });

  it('filters by district in SQL', async () => {
    await seedVenue({ name: 'K', district: 'Kadikoy' });
    await seedVenue({ name: 'B', district: 'Besiktas' });
    const res = await listVenuesRoute(req('/venues?district=Besiktas'));
    const body = (await res.json()) as { venues: { name: string; district: string }[] };
    expect(body.venues.length).toBeGreaterThan(0);
    expect(body.venues.every((v) => v.district === 'Besiktas')).toBe(true);
  });

  it('filters by type in SQL', async () => {
    await seedVenue({ name: 'Club X', type: 'club', district: 'Sisli' });
    await seedVenue({ name: 'Cafe Y', type: 'cafe', district: 'Sisli' });
    const res = await listVenuesRoute(req('/venues?district=Sisli&type=club'));
    const body = (await res.json()) as { venues: { type: string; district: string }[] };
    expect(body.venues.length).toBe(1);
    expect(body.venues[0]?.type).toBe('club');
  });

  it('rejects an unknown type value with 400', async () => {
    expect((await listVenuesRoute(req('/venues?type=speakeasy'))).status).toBe(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    expect((await listVenuesRoute(req('/venues', false))).status).toBe(401);
  });
});

describe('GET /venues/:id', () => {
  it('returns one venue with only public fields serialized', async () => {
    const id = await seedVenue({ name: 'Solo' });
    const res = await getVenueRoute(req(`/venues/${id}`), idCtx(id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS);
    for (const k of INTERNAL_KEYS) expect(k in body).toBe(false);
  });

  it('returns 404 for a non-existent id', async () => {
    expect((await getVenueRoute(req(`/venues/${ulid()}`), idCtx(ulid()))).status).toBe(404);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const id = await seedVenue({ name: 'Z' });
    expect((await getVenueRoute(req(`/venues/${id}`, false), idCtx(id))).status).toBe(401);
  });
});

describe('column-scoped grant (0010)', () => {
  it('refuses unlisted_app SELECT on licence_ref outright but allows the public columns', async () => {
    await seedVenue({ name: 'Grant probe' });
    // SET LOCAL ROLE drops superuser + BYPASSRLS for the rest of the txn, so
    // column privileges apply exactly as they would for a real app login
    // (docs/state.md Traps).
    const client = await t.pool.connect();
    try {
      for (const column of ['licence_ref', 'capacity_hint']) {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE unlisted_app');
        await expect(client.query(`SELECT ${column} FROM venue`)).rejects.toThrow(
          /permission denied/,
        );
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unlisted_app');
      await expect(
        client.query('SELECT id, name, address, district, type, operator_verified FROM venue'),
      ).resolves.toBeDefined();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const priv = await t.pool.query<{ can: boolean }>(
      `SELECT has_column_privilege('unlisted_app', 'public.venue', 'licence_ref', 'SELECT') AS can`,
    );
    expect(priv.rows[0]?.can).toBe(false);
  });
});
