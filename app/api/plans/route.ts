import { isValid as isUlid } from 'ulidx';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  activeHostMemberCount,
  circles,
  createDraftPlan,
  getSessionActor,
  getVenue,
  plans,
  recordAuditEntry,
} from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toPlanView } from '@/views';

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
