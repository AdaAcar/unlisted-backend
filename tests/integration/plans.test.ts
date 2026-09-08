import { NextRequest } from 'next/server';
import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as createPlanRoute } from '@/app/api/plans/route';
import { GET as getPlanRoute, PATCH as patchPlanRoute } from '@/app/api/plans/[id]/route';
import { POST as publishPlanRoute } from '@/app/api/plans/[id]/publish/route';
import { POST as cancelPlanRoute } from '@/app/api/plans/[id]/cancel/route';
import { POST as closePlanRoute } from '@/app/api/plans/[id]/close/route';
import { closePlanAtStartsAt, completePlan, lockPlan, type LockedPlan } from '@/db';
import { SYSTEM_ACTOR } from '@/db/scope/actor';
import { withActor } from '@/db/scope/scoped';
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

async function seedUser(opts: { verified?: boolean; standing?: string } = {}): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state, standing) VALUES ($1, 'U', $2, $3)`,
    [id, opts.verified === false ? 'none' : 'verified', opts.standing ?? 'good'],
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

async function seedVenue(
  district = 'Kadikoy',
  type = 'bar',
): Promise<{ id: string; district: string; type: string }> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO venue (id, name, address, district, type) VALUES ($1, 'V', 'Public address', $2, $3)`,
    [id, district, type],
  );
  return { id, district, type };
}

/** A circle with `leadId` as active lead and `extraActiveMembers` more active members. */
async function seedCircle(extraActiveMembers = 0): Promise<{ circleId: string; leadId: string }> {
  const leadId = await seedUser();
  const circleId = ulid();
  await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'Hosts', $2)`, [
    circleId,
    leadId,
  ]);
  await t.pool.query(
    `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
     VALUES ($1, $2, $3, 'lead', 'active', now())`,
    [ulid(), circleId, leadId],
  );
  for (let i = 0; i < extraActiveMembers; i += 1) {
    await t.pool.query(
      `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'member', 'active', now())`,
      [ulid(), circleId, await seedUser()],
    );
  }
  return { circleId, leadId };
}

async function addActiveMember(circleId: string): Promise<string> {
  const userId = await seedUser();
  await t.pool.query(
    `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
     VALUES ($1, $2, $3, 'member', 'active', now())`,
    [ulid(), circleId, userId],
  );
  return userId;
}

function jsonReq(cookie: string | undefined, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest('http://localhost/plans', {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

interface CreateOpts {
  district?: string;
  type?: string;
  startsInDays?: number;
  startsInHours?: number;
  openSpots?: number;
  minGroupSize?: number;
  note?: string | null;
}

function startsAtIso(opts: CreateOpts): string {
  const ms =
    opts.startsInHours !== undefined
      ? opts.startsInHours * 3600_000
      : (opts.startsInDays ?? 3) * 86_400_000;
  return new Date(Date.now() + ms).toISOString();
}

/** Create a draft plan through the route; returns its id (or throws on non-201). */
async function createDraft(
  cookie: string,
  circleId: string,
  venueId: string,
  opts: CreateOpts = {},
): Promise<string> {
  const res = await createPlanRoute(
    jsonReq(cookie, {
      hostCircleId: circleId,
      venueId,
      startsAt: startsAtIso(opts),
      openSpots: opts.openSpots ?? 2,
      minGroupSize: opts.minGroupSize ?? 1,
      ...(opts.note === undefined ? {} : { note: opts.note }),
    }),
  );
  if (res.status !== 201) {
    throw new Error(`createDraft expected 201, got ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as { id: string }).id;
}

async function planRow(id: string): Promise<Record<string, unknown>> {
  const { rows } = await t.pool.query(`SELECT * FROM plan WHERE id = $1`, [id]);
  return rows[0] as Record<string, unknown>;
}

async function auditActions(planId: string): Promise<string[]> {
  const { rows } = await t.pool.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY created_at`,
    [planId],
  );
  return rows.map((r) => r.action);
}

// ---------------------------------------------------------------------------
// Deny paths first (agent-rules section 8).
// ---------------------------------------------------------------------------

describe('POST /plans — authorization', () => {
  it('401 without a session', async () => {
    const { circleId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const res = await createPlanRoute(
      jsonReq(undefined, {
        hostCircleId: circleId,
        venueId,
        startsAt: startsAtIso({}),
        openSpots: 2,
        minGroupSize: 1,
      }),
    );
    expect(res.status).toBe(401);
  });

  it('404 for a user who is not a member of the host circle (existence not disclosed)', async () => {
    const { circleId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const outsider = await seedUser();
    const res = await createPlanRoute(
      jsonReq(await cookieFor(outsider), {
        hostCircleId: circleId,
        venueId,
        startsAt: startsAtIso({}),
        openSpots: 2,
        minGroupSize: 1,
      }),
    );
    expect(res.status).toBe(404);
  });

  it('403 for a circle member who is not the lead', async () => {
    const { circleId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const member = await addActiveMember(circleId);
    const res = await createPlanRoute(
      jsonReq(await cookieFor(member), {
        hostCircleId: circleId,
        venueId,
        startsAt: startsAtIso({}),
        openSpots: 2,
        minGroupSize: 1,
      }),
    );
    expect(res.status).toBe(403);
  });

  it('403 for an unverified lead and for a restricted-standing lead', async () => {
    const { id: venueId } = await seedVenue();

    const unverifiedLead = await seedUser({ verified: false });
    const c1 = ulid();
    await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'H', $2)`, [
      c1,
      unverifiedLead,
    ]);
    await t.pool.query(
      `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'lead', 'active', now())`,
      [ulid(), c1, unverifiedLead],
    );
    expect(
      (
        await createPlanRoute(
          jsonReq(await cookieFor(unverifiedLead), {
            hostCircleId: c1,
            venueId,
            startsAt: startsAtIso({}),
            openSpots: 2,
            minGroupSize: 1,
          }),
        )
      ).status,
    ).toBe(403);

    const restrictedLead = await seedUser({ standing: 'restricted' });
    const c2 = ulid();
    await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'H', $2)`, [
      c2,
      restrictedLead,
    ]);
    await t.pool.query(
      `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'lead', 'active', now())`,
      [ulid(), c2, restrictedLead],
    );
    expect(
      (
        await createPlanRoute(
          jsonReq(await cookieFor(restrictedLead), {
            hostCircleId: c2,
            venueId,
            startsAt: startsAtIso({}),
            openSpots: 2,
            minGroupSize: 1,
          }),
        )
      ).status,
    ).toBe(403);
  });

  it('422 for an unknown venue and for an infeasible plan', async () => {
    const { circleId, leadId } = await seedCircle();
    const cookie = await cookieFor(leadId);

    expect(
      (
        await createPlanRoute(
          jsonReq(cookie, {
            hostCircleId: circleId,
            venueId: ulid(),
            startsAt: startsAtIso({}),
            openSpots: 2,
            minGroupSize: 1,
          }),
        )
      ).status,
    ).toBe(422);

    const { id: venueId } = await seedVenue();
    // solo host (1) + 1 open spot = 2 < MIN_PLAN_TOTAL
    const res = await createPlanRoute(
      jsonReq(cookie, {
        hostCircleId: circleId,
        venueId,
        startsAt: startsAtIso({}),
        openSpots: 1,
        minGroupSize: 1,
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('infeasible');
  });

  it('422 for a start time in the past or an end before the start', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);

    expect(
      (
        await createPlanRoute(
          jsonReq(cookie, {
            hostCircleId: circleId,
            venueId,
            startsAt: new Date(Date.now() - 3600_000).toISOString(),
            openSpots: 2,
            minGroupSize: 1,
          }),
        )
      ).status,
    ).toBe(422);

    expect(
      (
        await createPlanRoute(
          jsonReq(cookie, {
            hostCircleId: circleId,
            venueId,
            startsAt: startsAtIso({ startsInDays: 3 }),
            endsAt: startsAtIso({ startsInDays: 2 }),
            openSpots: 2,
            minGroupSize: 1,
          }),
        )
      ).status,
    ).toBe(422);
  });
});

describe('mutation routes — authorization', () => {
  it('403 for a non-lead member on publish / patch / cancel / close', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const planId = await createDraft(await cookieFor(leadId), circleId, venueId);
    const memberCookie = await cookieFor(await addActiveMember(circleId));

    for (const route of [publishPlanRoute, cancelPlanRoute, closePlanRoute]) {
      expect((await route(jsonReq(memberCookie, undefined), idCtx(planId))).status).toBe(403);
    }
    expect(
      (await patchPlanRoute(jsonReq(memberCookie, { openSpots: 5 }, 'PATCH'), idCtx(planId)))
        .status,
    ).toBe(403);
  });

  it('404 for every :id route on an unknown plan, and on a draft the actor cannot see', async () => {
    const stranger = await cookieFor(await seedUser());
    const unknown = ulid();
    expect((await getPlanRoute(jsonReq(stranger, undefined, 'GET'), idCtx(unknown))).status).toBe(
      404,
    );
    expect((await publishPlanRoute(jsonReq(stranger, undefined), idCtx(unknown))).status).toBe(404);
    expect((await cancelPlanRoute(jsonReq(stranger, undefined), idCtx(unknown))).status).toBe(404);

    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const draftId = await createDraft(await cookieFor(leadId), circleId, venueId);
    // An unrelated user cannot see the unpublished plan at all.
    expect((await getPlanRoute(jsonReq(stranger, undefined, 'GET'), idCtx(draftId))).status).toBe(
      404,
    );
  });

  it('401 without a session on a :id route', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const planId = await createDraft(await cookieFor(leadId), circleId, venueId);
    expect((await cancelPlanRoute(jsonReq(undefined, undefined), idCtx(planId))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

describe('POST /plans — create draft', () => {
  it('creates a draft with mode null and district / venue_type copied from the venue', async () => {
    const { circleId, leadId } = await seedCircle();
    const venue = await seedVenue('Besiktas', 'club');
    const res = await createPlanRoute(
      jsonReq(await cookieFor(leadId), {
        hostCircleId: circleId,
        venueId: venue.id,
        startsAt: startsAtIso({ startsInDays: 4 }),
        openSpots: 3,
        minGroupSize: 2,
        note: 'rooftop',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe('draft');
    expect(body.mode).toBeNull();
    expect(body.district).toBe('Besiktas');
    expect(body.venueType).toBe('club');
    expect(body.viable).toBe(false);
    expect(body.applicationsClosed).toBe(false);
    expect(body.note).toBe('rooftop');
    // The view never carries raw attendance counters.
    for (const leaked of [
      'confirmedHostCount',
      'acceptedGuestCount',
      'heldCount',
      'confirmedTotal',
    ]) {
      expect(body).not.toHaveProperty(leaked);
    }
    expect(await auditActions(body.id as string)).toEqual(['plan_create']);

    const row = await planRow(body.id as string);
    expect(row.district).toBe('Besiktas');
    expect(row.venue_type).toBe('club');
    expect(row.mode).toBeNull();
  });
});

describe('POST /plans/:id/publish', () => {
  it('computes planned mode for a start >= SPONTANEOUS_THRESHOLD_H away and leaves a solo host non-viable', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { startsInDays: 3, openSpots: 3 });

    const res = await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe('planned');
    expect(body.state).toBe('published');
    expect(body.viable).toBe(false);

    const row = await planRow(planId);
    expect(row.mode).toBe('planned');
    expect(row.confirmed_host_count).toBe(1);
    expect(row.viable_at).toBeNull();
    expect(row.published_at).not.toBeNull();
    expect(await auditActions(planId)).toEqual(['plan_create', 'plan_publish']);
  });

  it('computes tonight mode for a start inside SPONTANEOUS_THRESHOLD_H', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { startsInHours: 5, openSpots: 3 });

    const res = await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mode: string }).mode).toBe('tonight');
  });

  it('does NOT latch viable_at at publish for a host circle alone (Decision B: needs an accepted guest)', async () => {
    const { circleId, leadId } = await seedCircle(2); // lead + 2 = 3 active hosts
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { openSpots: 2 });

    const res = await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { viable: boolean }).viable).toBe(false);

    const row = await planRow(planId);
    expect(row.confirmed_host_count).toBe(3);
    expect(row.viable_at).toBeNull();

    // No introduction ledger rows: a host circle meeting itself is not a plan
    // that came together (docs/state.md Decisions C7b + C7c).
    const intro = await t.pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM plan_participant_introduction WHERE plan_id = $1`,
      [planId],
    );
    expect(Number(intro.rows[0]?.n)).toBe(0);
  });

  it('rejects publish of an infeasible plan (host + open spots < MIN_PLAN_TOTAL)', async () => {
    // Feasible at create (1 host + 2 spots = 3), then a spot is removed so the
    // plan is infeasible by publish time.
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { openSpots: 2 });
    await t.pool.query(`UPDATE plan SET open_spots = 0 WHERE id = $1`, [planId]);

    const res = await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('not_publishable');
    expect((await planRow(planId)).state).toBe('draft');
  });

  it('rejects publish once the start has already passed, and rejects a second publish', async () => {
    const { circleId, leadId } = await seedCircle(2);
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId);
    await t.pool.query(`UPDATE plan SET starts_at = now() - interval '1 hour' WHERE id = $1`, [
      planId,
    ]);
    expect((await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId))).status).toBe(422);

    await t.pool.query(`UPDATE plan SET starts_at = now() + interval '3 days' WHERE id = $1`, [
      planId,
    ]);
    expect((await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId))).status).toBe(200);
    expect((await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId))).status).toBe(422);
  });
});

describe('plan.mode is immutable after publish (0001_guards.sql backstop)', () => {
  it('a raw UPDATE that changes a non-null mode is rejected by the database', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { startsInDays: 3 });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    expect((await planRow(planId)).mode).toBe('planned');

    await expect(
      t.pool.query(`UPDATE plan SET mode = 'tonight' WHERE id = $1`, [planId]),
    ).rejects.toThrow(/immutable/i);
    expect((await planRow(planId)).mode).toBe('planned');
  });
});

describe('PATCH /plans/:id', () => {
  it('edits venue / time freely while draft, and recopies district from the new venue', async () => {
    const { circleId, leadId } = await seedCircle();
    const first = await seedVenue('Kadikoy', 'bar');
    const second = await seedVenue('Sisli', 'restaurant');
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, first.id);

    const res = await patchPlanRoute(
      jsonReq(cookie, { venueId: second.id, openSpots: 4, note: 'moved' }, 'PATCH'),
      idCtx(planId),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.venueId).toBe(second.id);
    expect(body.district).toBe('Sisli');
    expect(body.venueType).toBe('restaurant');
    expect(body.openSpots).toBe(4);
    expect(body.note).toBe('moved');
    expect(await auditActions(planId)).toContain('plan_edit');
  });

  it('freezes venue, start, end and minimum group size once a spot is held or accepted', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const other = await seedVenue('Uskudar', 'cafe');
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { openSpots: 3, startsInDays: 5 });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    // Simulate C7: someone has been invited (soft hold) — the durable trace C3
    // keys "immutable after first invitation" off, since invitations are C7.
    await t.pool.query(`UPDATE plan SET held_count = 1 WHERE id = $1`, [planId]);

    for (const frozen of [
      { venueId: other.id },
      { startsAt: startsAtIso({ startsInDays: 6 }) },
      { endsAt: startsAtIso({ startsInDays: 7 }) },
      { minGroupSize: 2 },
      { openSpots: 2 }, // lowering is disallowed
    ]) {
      const res = await patchPlanRoute(jsonReq(cookie, frozen, 'PATCH'), idCtx(planId));
      expect(res.status, JSON.stringify(frozen)).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('plan_locked');
    }
  });

  it('keeps the note and a spot increase editable after a hold', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { openSpots: 3, startsInDays: 5 });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    await t.pool.query(`UPDATE plan SET held_count = 1 WHERE id = $1`, [planId]);

    expect(
      (await patchPlanRoute(jsonReq(cookie, { note: 'still ok' }, 'PATCH'), idCtx(planId))).status,
    ).toBe(200);
    expect(
      (await patchPlanRoute(jsonReq(cookie, { openSpots: 5 }, 'PATCH'), idCtx(planId))).status,
    ).toBe(200);
    expect((await planRow(planId)).venue_id).toBe(venueId);
  });

  it('409 not_editable once the plan is cancelled', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId);
    await cancelPlanRoute(jsonReq(cookie, undefined), idCtx(planId));

    const res = await patchPlanRoute(jsonReq(cookie, { openSpots: 9 }, 'PATCH'), idCtx(planId));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('not_editable');
  });
});

describe('POST /plans/:id/cancel and /close', () => {
  it('cancels a published plan, and a second cancel is 409', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { startsInDays: 3 });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));

    const res = await cancelPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe('cancelled');
    const row = await planRow(planId);
    expect(row.cancellation_kind).toBe('host');
    expect(row.cancelled_at).not.toBeNull();

    expect((await cancelPlanRoute(jsonReq(cookie, undefined), idCtx(planId))).status).toBe(409);
    expect(await auditActions(planId)).toEqual(['plan_create', 'plan_publish', 'plan_cancel']);
  });

  it('manually closes applications on a published plan; closing again is 409', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { startsInDays: 3 });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));

    const res = await closePlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe('applications_closed');
    expect(body.applicationsClosed).toBe(true);
    expect((await planRow(planId)).applications_closed_at).not.toBeNull();

    expect((await closePlanRoute(jsonReq(cookie, undefined), idCtx(planId))).status).toBe(409);
  });

  it('cannot close a draft (applications are not open yet)', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId);
    expect((await closePlanRoute(jsonReq(cookie, undefined), idCtx(planId))).status).toBe(409);
  });
});

describe('GET /plans/:id', () => {
  it('returns a published plan to any authenticated user and 404s a draft to outsiders', async () => {
    const { circleId, leadId } = await seedCircle();
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { startsInDays: 3 });

    const outsider = await cookieFor(await seedUser());
    expect((await getPlanRoute(jsonReq(outsider, undefined, 'GET'), idCtx(planId))).status).toBe(
      404,
    );

    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    const res = await getPlanRoute(jsonReq(outsider, undefined, 'GET'), idCtx(planId));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe('published');
  });
});

// ---------------------------------------------------------------------------
// E1 worker persist paths — no HTTP route (docs/api.md has none).
// ---------------------------------------------------------------------------

describe('closePlanAtStartsAt / completePlan (E1 write helpers)', () => {
  it('cancels a non-viable plan at starts_at as non_viable, and never routes a viable plan through applications_closed', async () => {
    const { circleId, leadId } = await seedCircle(); // solo host
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { startsInDays: 3, openSpots: 2 });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    await t.pool.query(`UPDATE plan SET starts_at = now() - interval '1 minute' WHERE id = $1`, [
      planId,
    ]);

    const actor = userActor(leadId);
    const state = await withActor(actor, async (executor) => {
      const locked = await lockPlan(executor, planId);
      return closePlanAtStartsAt(executor, locked!, new Date());
    });
    // The helper returns only a plan-state string — no attendee data (§3).
    expect(state).toBe('cancelled');
    const row = await planRow(planId);
    expect(row.cancellation_kind).toBe('non_viable');
    expect(row.applications_closed_at).not.toBeNull();
    // Auto-cancel reveals nobody: no thread, and the introduction ledger is
    // untouched (a non-viable plan has no viable_plan_key, so neither is even
    // reachable).
    expect(
      (await t.pool.query(`SELECT 1 FROM message_thread WHERE plan_id = $1`, [planId])).rowCount,
    ).toBe(0);
    const ledger = await t.pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM plan_participant_introduction WHERE plan_id = $1`,
      [planId],
    );
    expect(Number(ledger.rows[0]?.n)).toBe(0);
  });

  it('completes a viable plan past its start and banks the host circle record counter', async () => {
    const { circleId, leadId } = await seedCircle(2); // 3 active hosts
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, circleId, venueId, { startsInDays: 3, openSpots: 2 });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));
    // Decision B: viability now needs an accepted guest. Latch it directly
    // (3 hosts + 1 guest = 4 >= MIN_PLAN_TOTAL, guest >= 1).
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = 1, viable_at = now() WHERE id = $1`,
      [planId],
    );
    await t.pool.query(`UPDATE plan SET starts_at = now() - interval '1 minute' WHERE id = $1`, [
      planId,
    ]);

    const actor = userActor(leadId);
    const outcome = await withActor(actor, async (executor) => {
      const locked = await lockPlan(executor, planId);
      return completePlan(executor, locked!, new Date());
    });
    expect(outcome).toBe('completed');
    const row = await planRow(planId);
    expect(row.state).toBe('completed');
    expect(row.completed_at).not.toBeNull();
    // Decision C: plan completion banks circle.plans_hosted for the host circle.
    const circle = await t.pool.query<{ plans_hosted: number; plans_attended: number }>(
      `SELECT plans_hosted, plans_attended FROM circle WHERE id = $1`,
      [circleId],
    );
    expect(circle.rows[0]).toEqual({ plans_hosted: 1, plans_attended: 0 });
  });

  it('completePlan banks plans_attended for a distinct guest circle with an accepted application', async () => {
    const { circleId: hostCircleId, leadId } = await seedCircle(2); // 3 active hosts
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, hostCircleId, venueId, {
      startsInDays: 3,
      openSpots: 2,
    });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));

    // A guest circle with one accepted planned application on the plan.
    const guestLead = await seedUser();
    const guestCircleId = ulid();
    await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'Guests', $2)`, [
      guestCircleId,
      guestLead,
    ]);
    await t.pool.query(
      `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'lead', 'active', now())`,
      [ulid(), guestCircleId, guestLead],
    );
    const appId = ulid();
    await t.pool.query(
      `INSERT INTO application (id, plan_id, applicant_circle_id, mode, state, submitted_at)
       VALUES ($1, $2, $3, 'planned', 'accepted', now())`,
      [appId, planId, guestCircleId],
    );
    await t.pool.query(
      `INSERT INTO application_member (id, application_id, user_id, invitation_state)
       VALUES ($1, $2, $3, 'accepted')`,
      [ulid(), appId, guestLead],
    );
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = 1, viable_at = now() WHERE id = $1`,
      [planId],
    );
    await t.pool.query(`UPDATE plan SET starts_at = now() - interval '1 minute' WHERE id = $1`, [
      planId,
    ]);

    await withActor(userActor(leadId), async (executor) => {
      const locked = await lockPlan(executor, planId);
      return completePlan(executor, locked!, new Date());
    });

    const host = await t.pool.query<{ plans_hosted: number; plans_attended: number }>(
      `SELECT plans_hosted, plans_attended FROM circle WHERE id = $1`,
      [hostCircleId],
    );
    const guest = await t.pool.query<{ plans_hosted: number; plans_attended: number }>(
      `SELECT plans_hosted, plans_attended FROM circle WHERE id = $1`,
      [guestCircleId],
    );
    expect(host.rows[0]).toEqual({ plans_hosted: 1, plans_attended: 0 });
    expect(guest.rows[0]).toEqual({ plans_hosted: 0, plans_attended: 1 });
  });

  // --- C7c fix (0015): the guest-circle read must not depend on the caller's
  // `application` visibility. E1's worker will be the first production caller
  // and runs as SYSTEM_ACTOR. -------------------------------------------------

  interface GuestCircleSeed {
    circleId: string;
    leadId: string;
  }

  /**
   * A published, viable, past-`starts_at` plan ready for `completePlan`, plus a
   * guest circle with one live accepted/approved circle application on it.
   * `mode` picks which arm — a `planned` circle app is `accepted`; a `tonight`
   * circle app is `approved`. NOTE: C5 makes every tonight application solo, so
   * a tonight *circle* application cannot be created through the API — it is
   * seeded directly here purely to cover the helper's `tonight`/`approved`
   * branch.
   */
  async function seedCompletablePlanWithGuestCircle(
    mode: 'planned' | 'tonight',
  ): Promise<{ planId: string; host: GuestCircleSeed; guest: GuestCircleSeed }> {
    const { circleId: hostCircleId, leadId: hostLeadId } = await seedCircle(2); // 3 active hosts
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(hostLeadId);
    // Publish derives the mode from the horizon (planned >= SPONTANEOUS_THRESHOLD_H,
    // else tonight) and it is immutable after — so choose the horizon, not a
    // post-publish UPDATE.
    const planId = await createDraft(cookie, hostCircleId, venueId, {
      ...(mode === 'tonight' ? { startsInHours: 5 } : { startsInDays: 3 }),
      openSpots: 2,
    });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));

    const guestLeadId = await seedUser();
    const guestCircleId = ulid();
    await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1, 'Guests', $2)`, [
      guestCircleId,
      guestLeadId,
    ]);
    await t.pool.query(
      `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'lead', 'active', now())`,
      [ulid(), guestCircleId, guestLeadId],
    );
    const appId = ulid();
    const appState = mode === 'planned' ? 'accepted' : 'approved';
    await t.pool.query(
      `INSERT INTO application (id, plan_id, applicant_circle_id, mode, state, submitted_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [appId, planId, guestCircleId, mode, appState],
    );
    await t.pool.query(
      `INSERT INTO application_member (id, application_id, user_id, invitation_state)
       VALUES ($1, $2, $3, 'accepted')`,
      [ulid(), appId, guestLeadId],
    );
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = 1, viable_at = now() WHERE id = $1`,
      [planId],
    );
    await t.pool.query(`UPDATE plan SET starts_at = now() - interval '1 minute' WHERE id = $1`, [
      planId,
    ]);

    return {
      planId,
      host: { circleId: hostCircleId, leadId: hostLeadId },
      guest: { circleId: guestCircleId, leadId: guestLeadId },
    };
  }

  /** Build a LockedPlan straight from the row (bypasses lockPlan's RLS, which a
   *  SYSTEM_ACTOR cannot pass — see docs/state.md Known gaps C5/C6/C7a). */
  async function rawLockedPlan(planId: string): Promise<LockedPlan> {
    const { rows } = await t.pool.query(`SELECT * FROM plan WHERE id = $1`, [planId]);
    const r = rows[0] as Record<string, unknown>;
    return {
      id: r.id as string,
      hostCircleId: r.host_circle_id as string,
      venueId: r.venue_id as string,
      state: r.state as LockedPlan['state'],
      mode: r.mode as LockedPlan['mode'],
      startsAt: new Date(r.starts_at as string),
      endsAt: r.ends_at ? new Date(r.ends_at as string) : null,
      openSpots: Number(r.open_spots),
      minGroupSize: Number(r.min_group_size),
      note: (r.note as string | null) ?? null,
      confirmedHostCount: Number(r.confirmed_host_count),
      acceptedGuestCount: Number(r.accepted_guest_count),
      heldCount: Number(r.held_count),
      viableAt: r.viable_at ? new Date(r.viable_at as string) : null,
      applicationsClosedAt: r.applications_closed_at
        ? new Date(r.applications_closed_at as string)
        : null,
      cancellationKind: (r.cancellation_kind as LockedPlan['cancellationKind']) ?? null,
    };
  }

  async function circleCounters(
    circleId: string,
  ): Promise<{ plans_hosted: number; plans_attended: number }> {
    const { rows } = await t.pool.query<{ plans_hosted: number; plans_attended: number }>(
      `SELECT plans_hosted, plans_attended FROM circle WHERE id = $1`,
      [circleId],
    );
    return rows[0]!;
  }

  it('REGRESSION: completePlan run as SYSTEM_ACTOR still banks plans_hosted and plans_attended', async () => {
    // Before 0015 this failed with plans_attended = 0 (empty result, no error):
    // the inline `SELECT ... FROM application` ran under app_application_visible,
    // which matches nothing for a system: actor id. The 0015 SECURITY DEFINER
    // helper does not depend on the caller's scope.
    const { planId, host, guest } = await seedCompletablePlanWithGuestCircle('planned');

    const outcome = await withActor(SYSTEM_ACTOR, async (executor) => {
      const locked = await rawLockedPlan(planId);
      return completePlan(executor, locked, new Date());
    });
    expect(outcome).toBe('completed');

    expect(await circleCounters(host.circleId)).toEqual({ plans_hosted: 1, plans_attended: 0 });
    expect(await circleCounters(guest.circleId)).toEqual({ plans_hosted: 0, plans_attended: 1 });
  });

  it('the guest-circle read covers the tonight/approved branch too (seeded directly — C5 makes tonight solo)', async () => {
    const { planId, host, guest } = await seedCompletablePlanWithGuestCircle('tonight');

    await withActor(SYSTEM_ACTOR, async (executor) => {
      const locked = await rawLockedPlan(planId);
      return completePlan(executor, locked, new Date());
    });

    expect(await circleCounters(host.circleId)).toEqual({ plans_hosted: 1, plans_attended: 0 });
    expect(await circleCounters(guest.circleId)).toEqual({ plans_hosted: 0, plans_attended: 1 });
  });

  it('a solo guest accrues nothing — no circle, no counter', async () => {
    const { circleId: hostCircleId, leadId } = await seedCircle(2);
    const { id: venueId } = await seedVenue();
    const cookie = await cookieFor(leadId);
    const planId = await createDraft(cookie, hostCircleId, venueId, {
      startsInDays: 3,
      openSpots: 2,
    });
    await publishPlanRoute(jsonReq(cookie, undefined), idCtx(planId));

    // A solo accepted applicant — no applicant_circle_id.
    const soloGuest = await seedUser();
    await t.pool.query(
      `INSERT INTO application (id, plan_id, solo_user_id, mode, state, submitted_at)
       VALUES ($1, $2, $3, 'planned', 'accepted', now())`,
      [ulid(), planId, soloGuest],
    );
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = 1, viable_at = now() WHERE id = $1`,
      [planId],
    );
    await t.pool.query(`UPDATE plan SET starts_at = now() - interval '1 minute' WHERE id = $1`, [
      planId,
    ]);

    await withActor(SYSTEM_ACTOR, async (executor) => {
      const locked = await rawLockedPlan(planId);
      return completePlan(executor, locked, new Date());
    });

    // Only the host circle's counter moved; the solo guest has no circle row to
    // bank against.
    expect(await circleCounters(hostCircleId)).toEqual({ plans_hosted: 1, plans_attended: 0 });
  });
});
