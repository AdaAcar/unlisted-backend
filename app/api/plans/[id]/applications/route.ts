import { isValid as isUlid } from 'ulidx';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  circles,
  createApplication,
  getApplication,
  listPlanApplications,
  recordAuditEntry,
} from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toApplicationReviewView, toApplicationView } from '@/views';

import { forbidden, notFound, planContext } from '../../context';

/**
 * `POST /plans/:id/applications` (docs/api.md Applications; docs/modes.md):
 * session + verified + standing=good, circle lead or solo applicant. Enforces
 * `min_group_size`.
 *
 * - planned + `applicantCircleId`: a group application — one member row per
 *   named member, all unconfirmed; state `awaiting_confirmation`.
 * - planned, no circle: a solo application, straight to `submitted`.
 * - tonight: always solo in effect (docs/modes.md) — any group intent is
 *   ignored, the caller binds only themselves; state `submitted`.
 */
const createBody = z.object({
  applicantCircleId: z.string().refine(isUlid, 'must be a valid ulid').optional(),
  memberUserIds: z.array(z.string().refine(isUlid, 'must be a valid ulid')).max(50).optional(),
  note: z.string().trim().min(1).max(2000).nullish(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: planId } = await params;

  const body = await request.json().catch(() => null);
  const parsed = createBody.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const input = parsed.data;

  const ctx = await planContext(request, planId);
  if (!ctx.ok) return ctx.response;
  const { actor, plan } = ctx;

  if (plan.state !== 'published') {
    return NextResponse.json({ error: 'applications_closed' }, { status: 409 });
  }
  const mode = plan.mode ?? 'planned';

  // Tonight mode: solo only. A group request binds just the caller.
  const asCircle = mode === 'planned' && input.applicantCircleId !== undefined;

  let applicantFactsRole: 'lead' | 'member' | null = null;
  let memberUserIds: string[] = [];
  if (asCircle) {
    const circle = await circles.get(actor, input.applicantCircleId as string);
    if (!circle) return notFound();
    const facts = await circles.membershipFacts(actor, input.applicantCircleId as string);
    applicantFactsRole = facts.actorRole;
    memberUserIds = [...new Set(input.memberUserIds ?? [])];
    if (memberUserIds.length === 0) {
      return NextResponse.json({ error: 'no_members' }, { status: 400 });
    }
    if (!memberUserIds.every((uid) => circle.memberIds.includes(uid))) {
      return NextResponse.json({ error: 'not_a_member' }, { status: 422 });
    }
  }

  if (
    policy(actor, 'application.create', {
      applyingAsCircle: asCircle,
      actorRole: applicantFactsRole,
    }) !== 'allow'
  ) {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const outcome = await withActor(actor, async (executor) => {
    const created = await createApplication(executor, {
      planId,
      mode,
      applicantCircleId: asCircle ? (input.applicantCircleId as string) : null,
      soloUserId: asCircle ? null : actor.id,
      note: input.note ?? null,
      memberUserIds,
      minGroupSize: plan.minGroupSize,
    });
    if (!created.ok) return created;
    await recordAuditEntry(executor, actor, {
      action: 'application_create',
      actorRole: 'user',
      resourceId: created.id,
      resourceType: 'application',
      afterState: { planId, mode, applicantKind: asCircle ? 'circle' : 'solo' },
      ipHash,
      userAgentHash,
    });
    return created;
  });

  if (!outcome.ok) {
    const status = outcome.reason === 'already_applied' ? 409 : 422;
    return NextResponse.json({ error: outcome.reason }, { status });
  }

  const record = await getApplication(actor, outcome.id);
  if (!record) return notFound();
  return NextResponse.json(toApplicationView(record), { status: 201 });
}

/**
 * `GET /plans/:id/applications` (docs/api.md Review): host circle lead only.
 * Applications with group context preserved — each applicant circle's members
 * shown together, never flattened (§3: this is the host's view, not shared).
 * In-progress applications (`draft` / `awaiting_confirmation`) are not shown.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: planId } = await params;

  const ctx = await planContext(request, planId);
  if (!ctx.ok) return ctx.response;
  const { actor, facts } = ctx;

  if (policy(actor, 'review.listApplications', { actorRole: facts.actorRole }) !== 'allow') {
    return forbidden();
  }

  const rows = await listPlanApplications(actor, planId);
  return NextResponse.json({ applications: rows.map(toApplicationReviewView) }, { status: 200 });
}
