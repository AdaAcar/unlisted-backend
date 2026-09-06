import { NextRequest } from 'next/server';
import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as feedRoute } from '@/app/api/plans/route';
import { plans } from '@/db';
import { generateSessionToken, hashSessionToken } from '@/lib/sessionToken';

import { userActor } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;

beforeAll(async () => {
  t = await freshDb();
});

afterAll(async () => {
  await t?.close();
});

async function seedUser(): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state, standing) VALUES ($1, 'U', 'verified', 'good')`,
    [id],
  );
  return id;
}

async function cookieFor(userId: string): Promise<string> {
  const token = generateSessionToken();
  await t.pool.query(
    `INSERT INTO session (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [ulid(), userId, hashSessionToken(token)],
  );
  return `session=${token}`;
}

async function seedCircle(leadId: string): Promise<string> {
  const circleId = ulid();
  await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'H', $2)`, [
    circleId,
    leadId,
  ]);
  await t.pool.query(
    `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
     VALUES ($1, $2, $3, 'lead', 'active', now())`,
    [ulid(), circleId, leadId],
  );
  return circleId;
}

async function seedVenue(district: string, type = 'bar'): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO venue (id, name, address, district, type) VALUES ($1, 'V', 'addr', $2, $3)`,
    [id, district, type],
  );
  return id;
}

interface PlanOpts {
  district: string;
  venueType?: string;
  startsInDays?: number;
  openSpots?: number;
  state?: string;
}

async function seedPlan(hostCircleId: string, opts: PlanOpts): Promise<string> {
  const id = ulid();
  const venueId = await seedVenue(opts.district, opts.venueType ?? 'bar');
  await t.pool.query(
    `INSERT INTO plan
       (id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
        district, venue_type, state, mode, published_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5, 1,
             $6, $7, $8, 'planned', now())`,
    [
      id,
      hostCircleId,
      venueId,
      String(opts.startsInDays ?? 5),
      opts.openSpots ?? 3,
      opts.district,
      opts.venueType ?? 'bar',
      opts.state ?? 'published',
    ],
  );
  return id;
}

function req(cookie: string | undefined, qs: string): NextRequest {
  return new NextRequest(`http://localhost/plans${qs}`, {
    method: 'GET',
    headers: cookie ? { cookie } : {},
  });
}

interface FeedBody {
  plans: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

async function feed(cookie: string, qs: string): Promise<{ status: number; body: FeedBody }> {
  const res = await feedRoute(req(cookie, qs));
  return { status: res.status, body: (await res.json()) as FeedBody };
}

// ---------------------------------------------------------------------------
// Deny / input validation first.
// ---------------------------------------------------------------------------

describe('GET /plans — input', () => {
  it('401 without a session', async () => {
    expect((await feedRoute(req(undefined, '?district=Kadikoy'))).status).toBe(401);
  });

  it('400 when district is missing (required — shrinks the enumeration surface)', async () => {
    const cookie = await cookieFor(await seedUser());
    expect((await feedRoute(req(cookie, ''))).status).toBe(400);
    expect((await feedRoute(req(cookie, '?dateFrom=2026-01-01T00:00:00Z'))).status).toBe(400);
  });

  it('400 invalid_cursor for a malformed or forged cursor', async () => {
    const cookie = await cookieFor(await seedUser());
    for (const bad of ['not-base64!!', Buffer.from('{"s":"nope"}').toString('base64url')]) {
      const res = await feedRoute(
        req(cookie, `?district=Kadikoy&cursor=${encodeURIComponent(bad)}`),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_cursor');
    }
  });

  it('400 for a non-positive or non-numeric limit', async () => {
    const cookie = await cookieFor(await seedUser());
    for (const bad of ['0', '-3', 'abc']) {
      expect((await feedRoute(req(cookie, `?district=Kadikoy&limit=${bad}`))).status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// The feed itself.
// ---------------------------------------------------------------------------

describe('GET /plans — feed shape and filters', () => {
  it('returns published plans in the district, ordered by start, with no attendee-derived fields', async () => {
    const lead = await seedUser();
    const circleId = await seedCircle(lead);
    const near = await seedPlan(circleId, { district: 'Besiktas', startsInDays: 2 });
    const far = await seedPlan(circleId, { district: 'Besiktas', startsInDays: 9 });
    await seedPlan(circleId, { district: 'Kadikoy', startsInDays: 3 }); // other district

    const { status, body } = await feed(await cookieFor(await seedUser()), '?district=Besiktas');
    expect(status).toBe(200);
    expect(body.plans.map((p) => p.id)).toEqual([near, far]);
    expect(body).not.toHaveProperty('total');

    const row = body.plans[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        'district',
        'endsAt',
        'id',
        'minGroupSize',
        'mode',
        'note',
        'openSpots',
        'startsAt',
        'venueId',
        'venueType',
      ].sort(),
    );
    for (const leaked of [
      'hostCircleId',
      'state',
      'viable',
      'confirmedHostCount',
      'acceptedGuestCount',
      'heldCount',
      'confirmedTotal',
    ]) {
      expect(row).not.toHaveProperty(leaked);
    }
  });

  it('applies venue type and date-range filters in SQL', async () => {
    const lead = await seedUser();
    const circleId = await seedCircle(lead);
    const bar = await seedPlan(circleId, { district: 'Sisli', venueType: 'bar', startsInDays: 4 });
    const club = await seedPlan(circleId, {
      district: 'Sisli',
      venueType: 'club',
      startsInDays: 20,
    });
    const cookie = await cookieFor(await seedUser());

    expect(
      (await feed(cookie, '?district=Sisli&venueType=club')).body.plans.map((p) => p.id),
    ).toEqual([club]);

    const dateTo = new Date(Date.now() + 10 * 86_400_000).toISOString();
    expect(
      (await feed(cookie, `?district=Sisli&dateTo=${encodeURIComponent(dateTo)}`)).body.plans.map(
        (p) => p.id,
      ),
    ).toEqual([bar]);

    // The block/enforcement predicate and the keyset comparison are both in the
    // compiled SQL, not applied to fetched rows.
    const compiled = plans
      .feed(userActor(lead), {
        district: 'Sisli',
        cursor: { id: ulid() },
        limit: 10,
      })
      .toSQL()
      .sql.toLowerCase();
    expect(compiled).toContain('not exists');
    expect(compiled).toContain('block');
    expect(compiled).toContain('starts_at, scoped_plan.id) >');
    expect(compiled).toContain('limit');
  });

  it('excludes draft, applications_closed and full plans', async () => {
    const lead = await seedUser();
    const circleId = await seedCircle(lead);
    const live = await seedPlan(circleId, { district: 'Uskudar' });
    await seedPlan(circleId, { district: 'Uskudar', state: 'draft' });
    await seedPlan(circleId, { district: 'Uskudar', state: 'applications_closed' });
    await seedPlan(circleId, { district: 'Uskudar', openSpots: 0 });

    const { body } = await feed(await cookieFor(await seedUser()), '?district=Uskudar');
    expect(body.plans.map((p) => p.id)).toEqual([live]);
  });

  it('excludes a plan whose host the viewer has blocked — before the row is serialized', async () => {
    const lead = await seedUser();
    const circleId = await seedCircle(lead);
    const planId = await seedPlan(circleId, { district: 'Bakirkoy' });
    const viewer = await seedUser();
    const cookie = await cookieFor(viewer);

    expect((await feed(cookie, '?district=Bakirkoy')).body.plans.map((p) => p.id)).toEqual([
      planId,
    ]);

    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      viewer,
      lead,
    ]);
    expect((await feed(cookie, '?district=Bakirkoy')).body.plans).toEqual([]);
  });
});

describe('GET /plans — pagination cannot enumerate', () => {
  it('pages through the full visible set exactly once, with no total and a terminating cursor', async () => {
    const lead = await seedUser();
    const circleId = await seedCircle(lead);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await seedPlan(circleId, { district: 'Maltepe', startsInDays: i + 1 }));
    }
    const cookie = await cookieFor(await seedUser());

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = `?district=Maltepe&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body }: { body: FeedBody } = await feed(cookie, qs);
      expect(body).not.toHaveProperty('total');
      seen.push(...body.plans.map((p) => p.id as string));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(4);
    } while (cursor !== null);

    expect(pages).toBe(3); // 2 + 2 + 1
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a cursor cannot page a viewer past a block into rows they may not see', async () => {
    const blockedLead = await seedUser();
    const blockedCircle = await seedCircle(blockedLead);
    await seedPlan(blockedCircle, { district: 'Atasehir', startsInDays: 1 });
    await seedPlan(blockedCircle, { district: 'Atasehir', startsInDays: 2 });

    const okLead = await seedUser();
    const okPlan = await seedPlan(await seedCircle(okLead), {
      district: 'Atasehir',
      startsInDays: 3,
    });

    const viewer = await seedUser();
    const cookie = await cookieFor(viewer);
    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      viewer,
      blockedLead,
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `?district=Atasehir&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body }: { body: FeedBody } = await feed(cookie, qs);
      seen.push(...body.plans.map((p) => p.id as string));
      cursor = body.nextCursor;
    } while (cursor !== null && seen.length < 10);

    expect(seen).toEqual([okPlan]); // never the two blocked-host plans, on any page
  });

  it('caps the page size regardless of a large limit', async () => {
    const lead = await seedUser();
    const circleId = await seedCircle(lead);
    for (let i = 0; i < 3; i += 1) {
      await seedPlan(circleId, { district: 'Pendik', startsInDays: i + 1 });
    }
    const cookie = await cookieFor(await seedUser());
    // limit far above FEED_PAGE_MAX is accepted but clamped; 3 rows fit under
    // the cap so nextCursor terminates.
    const { body } = await feed(cookie, '?district=Pendik&limit=9999');
    expect(body.plans).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
  });
});
