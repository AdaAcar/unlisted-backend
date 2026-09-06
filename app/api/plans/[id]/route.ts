import { isValid as isUlid } from 'ulidx';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { editPlan, getVenue, lockPlan, plans, recordAuditEntry } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toPlanView } from '@/views';

import { forbidden, notFound, planContext } from '../context';

/**
 * `GET /plans/:id` (docs/api.md Plans): a published plan, or any plan the
 * actor's circle hosts. Anything else is 404 — existence is not disclosed.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const ctx = await planContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, plan, facts } = ctx;

  if (
    policy(actor, 'plan.get', {
      published: plan.state !== 'draft',
      actorHostsCircle: facts.membershipStatus === 'active',
    }) !== 'allow'
  ) {
    return notFound();
  }

  return NextResponse.json(toPlanView(plan), { status: 200 });
}

/**
 * `PATCH /plans/:id` (docs/api.md Plans): host circle lead only. Editable while
 * `draft`, or `published` with nothing held, accepted, or latched. Once anyone
 * has been invited or accepted (or the plan has gone viable), venue, start,
 * end, and minimum group size are frozen and `open_spots` may only rise
 * (docs/state.md Decisions C3). `mode` is never editable (immutable after
 * publish — a DB trigger backstops this). `district` / `venue_type` follow the
 * chosen venue, never the client.
 */
const patchBody = z.object({
  venueId: z.string().refine(isUlid, 'must be a valid ulid').optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  openSpots: z.number().int().min(0).optional(),
  minGroupSize: z.number().int().min(1).optional(),
  note: z.string().trim().min(1).max(500).nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const patch = parsed.data;

  const ctx = await planContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, facts } = ctx;

  if (policy(actor, 'plan.update', { actorRole: facts.actorRole }) !== 'allow') {
    return forbidden();
  }

  const startsAt = patch.startsAt === undefined ? undefined : new Date(patch.startsAt);
  if (startsAt !== undefined && startsAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'starts_at_in_past' }, { status: 422 });
  }
  const endsAt =
    patch.endsAt === undefined ? undefined : patch.endsAt === null ? null : new Date(patch.endsAt);

  let venueFields: { district: string; venueType: string } | undefined;
  if (patch.venueId !== undefined) {
    const venue = await getVenue(actor, patch.venueId);
    if (!venue) {
      return NextResponse.json({ error: 'unknown_venue' }, { status: 422 });
    }
    venueFields = { district: venue.district, venueType: venue.type };
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const outcome = await withActor(actor, async (executor) => {
    const locked = await lockPlan(executor, id);
    if (!locked) return 'gone' as const;

    const result = await editPlan(executor, locked, {
      venueId: patch.venueId,
      district: venueFields?.district,
      venueType: venueFields?.venueType,
      startsAt,
      endsAt,
      openSpots: patch.openSpots,
      minGroupSize: patch.minGroupSize,
      note: patch.note,
    });

    if (result === 'edited') {
      await recordAuditEntry(executor, actor, {
        action: 'plan_edit',
        actorRole: 'circle_lead',
        resourceId: id,
        resourceType: 'plan',
        beforeState: {
          venueId: locked.venueId,
          startsAt: locked.startsAt.toISOString(),
          endsAt: locked.endsAt?.toISOString() ?? null,
          openSpots: locked.openSpots,
          minGroupSize: locked.minGroupSize,
        },
        afterState: {
          venueId: patch.venueId ?? locked.venueId,
          startsAt: (startsAt ?? locked.startsAt).toISOString(),
          endsAt: (endsAt === undefined ? locked.endsAt : endsAt)?.toISOString() ?? null,
          openSpots: patch.openSpots ?? locked.openSpots,
          minGroupSize: patch.minGroupSize ?? locked.minGroupSize,
        },
        ipHash,
        userAgentHash,
      });
    }
    return result;
  });

  if (outcome === 'gone') return notFound();
  if (outcome === 'not_editable') {
    return NextResponse.json({ error: 'not_editable' }, { status: 409 });
  }
  if (outcome === 'locked') {
    return NextResponse.json({ error: 'plan_locked' }, { status: 409 });
  }
  if (outcome === 'invalid_times') {
    return NextResponse.json({ error: 'ends_before_starts' }, { status: 422 });
  }

  const record = await plans.get(actor, id);
  if (!record) return notFound();
  return NextResponse.json(toPlanView(record), { status: 200 });
}
