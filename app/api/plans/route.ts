import { isValid as isUlid } from 'ulidx';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  activeHostMemberCount,
  circles,
  createDraftPlan,
  FEED_PAGE_DEFAULT,
  FEED_PAGE_MAX,
  getSessionActor,
  getVenue,
  plans,
  recordAuditEntry,
  VENUE_TYPES,
  type FeedCursor,
} from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toPlanFeedView, toPlanView } from '@/views';

/**
 * `POST /plans` (docs/api.md Plans): session + verified + standing=good, host
 * circle lead only. Creates a `draft` plan (no `mode` — that is computed at
 * publish). `district` / `venue_type` are copied from the venue row, never
 * taken from the client (A2 decision). Feasibility (`MIN_PLAN_TOTAL`) is
 * checked here and again, authoritatively, at publish.
 */
const createBody = z.object({
  hostCircleId: z.string().refine(isUlid, 'must be a valid ulid'),
  venueId: z.string().refine(isUlid, 'must be a valid ulid'),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullish(),
  openSpots: z.number().int().min(0),
  minGroupSize: z.number().int().min(1),
  note: z.string().trim().min(1).max(500).nullish(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = createBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const input = parsed.data;

  const startsAt = new Date(input.startsAt);
  const endsAt = input.endsAt == null ? null : new Date(input.endsAt);
  if (startsAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'starts_at_in_past' }, { status: 422 });
  }
  if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    return NextResponse.json({ error: 'ends_before_starts' }, { status: 422 });
  }

  const actor = await getSessionActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const facts = await circles.membershipFacts(actor, input.hostCircleId);
  if (facts.membershipStatus !== 'active') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (policy(actor, 'plan.create', { actorRole: facts.actorRole }) !== 'allow') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const venue = await getVenue(actor, input.venueId);
  if (!venue) {
    return NextResponse.json({ error: 'unknown_venue' }, { status: 422 });
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const outcome = await withActor(actor, async (executor) => {
    const hostCount = await activeHostMemberCount(executor, input.hostCircleId);
    const created = await createDraftPlan(
      executor,
      {
        hostCircleId: input.hostCircleId,
        venueId: input.venueId,
        district: venue.district,
        venueType: venue.type,
        startsAt,
        endsAt,
        openSpots: input.openSpots,
        minGroupSize: input.minGroupSize,
        note: input.note ?? null,
      },
      hostCount,
    );
    if (!created.ok) return created;
    await recordAuditEntry(executor, actor, {
      action: 'plan_create',
      actorRole: 'circle_lead',
      resourceId: created.id,
      resourceType: 'plan',
      afterState: {
        hostCircleId: input.hostCircleId,
        venueId: input.venueId,
        startsAt: startsAt.toISOString(),
        openSpots: input.openSpots,
        minGroupSize: input.minGroupSize,
      },
      ipHash,
      userAgentHash,
    });
    return created;
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: 'infeasible' }, { status: 422 });
  }

  const record = await plans.get(actor, outcome.id);
  if (!record) {
    // The creator hosts the circle, so the draft is visible to them; this is
    // unreachable barring a concurrent delete (which has no code path).
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(toPlanView(record), { status: 201 });
}

/**
 * `GET /plans` (docs/api.md Plans; docs/security.md enumeration): the discovery
 * feed. Wired to the A3 `plans.feed`, which already composes the block and
 * enforcement predicates into the SQL via `applyVisibility` — this route adds
 * nothing to that path, it only validates input and paginates.
 *
 * Enumeration defences (docs/security.md: the plan feed is the top scrape
 * target and revealing where someone will be is the worst failure mode):
 *
 * - `district` is required — a scraper must enumerate districts (coarse, few)
 *   rather than pull the whole set in one call, and it matches product.md's
 *   per-district "liquidity density".
 * - Keyset pagination over `(starts_at, id)` with an opaque, Zod-validated
 *   cursor and a hard page cap. No `OFFSET` (arbitrary jumps), no total count
 *   (a count leaks the size of the filtered-out set).
 * - The feed row (`PlanFeedView`) carries plan facts only: no attendee ids, no
 *   host member list, no attendance counts.
 * - Only `published` plans (the `plans.feed` predicate); a plan whose
 *   applications have closed has left `published` (C3 closure) and drops out.
 *
 * Rate limiting is D5 (Redis not installed) — recorded as a known gap.
 */
const feedQuery = z.object({
  district: z.string().trim().min(1),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  venueType: z.enum(VENUE_TYPES).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const cursorPayload = z.object({
  i: z.string().refine(isUlid, 'must be a valid ulid'),
});

function decodeCursor(raw: string): FeedCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = cursorPayload.safeParse(JSON.parse(json));
    return parsed.success ? { id: parsed.data.i } : null;
  } catch {
    return null;
  }
}

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ i: id }), 'utf8').toString('base64url');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = feedQuery.safeParse({
    district: request.nextUrl.searchParams.get('district') ?? undefined,
    dateFrom: request.nextUrl.searchParams.get('dateFrom') ?? undefined,
    dateTo: request.nextUrl.searchParams.get('dateTo') ?? undefined,
    venueType: request.nextUrl.searchParams.get('venueType') ?? undefined,
    cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
    limit: request.nextUrl.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const query = parsed.data;

  let cursor: FeedCursor | undefined;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    if (!decoded) {
      return NextResponse.json({ error: 'invalid_cursor' }, { status: 400 });
    }
    cursor = decoded;
  }

  const actor = await getSessionActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (policy(actor, 'plan.list', {}) !== 'allow') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const limit = Math.min(FEED_PAGE_MAX, query.limit ?? FEED_PAGE_DEFAULT);
  const rows = await plans.feed(actor, {
    district: query.district,
    startsAfter: query.dateFrom === undefined ? undefined : new Date(query.dateFrom),
    startsBefore: query.dateTo === undefined ? undefined : new Date(query.dateTo),
    venueType: query.venueType,
    cursor,
    limit,
  });

  const last = rows.at(-1);
  const nextCursor = rows.length === limit && last ? encodeCursor(last.id) : null;

  return NextResponse.json({ plans: rows.map(toPlanFeedView), nextCursor }, { status: 200 });
}
