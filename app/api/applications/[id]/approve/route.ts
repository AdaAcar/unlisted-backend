import { NextResponse, type NextRequest } from 'next/server';

import {
  approveApplication,
  circles,
  getApplication,
  lockApplication,
  lockPlan,
  recordAuditEntry,
} from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toApplicationView } from '@/views';

import { applicationContext, forbidden, notFound } from '../../context';

/**
 * `POST /applications/:id/approve` (docs/modes.md; todo_agent.md C7b): tonight
 * mode's one-tap acceptance. `:id` is the `application` id whose state is
 * `submitted`. Host circle lead only — **404 in planned mode** (the inverse of
 * every planned-mode route's guard).
 *
 * Gate: tonight mode is unavailable to a host circle below the record threshold
 * (docs/modes.md). Decision A (docs/state.md Decisions C7b + C7c): the gate is
 * cleared once the host circle's record shows `plans_hosted > 0 OR
 * plans_attended > 0`. Not cleared → `403 tonight_locked` (403, not 404 — the
 * lead can already see the plan).
 *
 * Idempotent: a repeat from `approved` returns the same result with no second
 * effect (no transaction). Any other non-`submitted` state is a 409. Approval
 * hard-consumes a spot under the plan row lock; the viability latch and the
 * thread fire if this is the third confirmed attendee (C7c).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const result = await applicationContext(request, id);
  if (!result.ok) return result.response;
  const { actor, application, plan, hostFacts } = result.ctx;

  if (application.mode !== 'tonight') return notFound();

  const gateCleared = await circles.tonightGateCleared(actor, plan.hostCircleId);
  if (!gateCleared) {
    return NextResponse.json({ error: 'tonight_locked' }, { status: 403 });
  }

  if (
    policy(actor, 'application.approve', {
      planMode: 'tonight',
      actorRole: hostFacts.actorRole,
    }) !== 'allow'
  ) {
    return forbidden();
  }

  // Idempotent no-op: an already-approved application returns the same result
  // without a second capacity transaction. A non-`submitted` state that is not
  // `approved` is a 409.
  if (application.state === 'approved') {
    return NextResponse.json(toApplicationView(application), { status: 200 });
  }
  if (application.state !== 'submitted') {
    return NextResponse.json({ error: 'not_approvable' }, { status: 409 });
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const lockedPlan = await lockPlan(executor, plan.id);
    const lockedApp = await lockApplication(executor, id);
    if (!lockedPlan || !lockedApp) return { kind: 'gone' as const };
    const res = await approveApplication(executor, lockedPlan, lockedApp, now);
    if (res.outcome === 'approved' && !res.idempotent) {
      await recordAuditEntry(executor, actor, {
        action: 'application_approve',
        actorRole: 'circle_lead',
        resourceId: id,
        resourceType: 'application',
        beforeState: { state: 'submitted' },
        afterState: { state: 'approved', viable: res.viable },
        ipHash,
        userAgentHash,
      });
    }
    return { kind: 'done' as const, res };
  });

  if (outcome.kind === 'gone') return notFound();
  const { res } = outcome;
  if (res.outcome === 'not_approvable') {
    return NextResponse.json({ error: 'not_approvable' }, { status: 409 });
  }
  if (res.outcome === 'capacity') {
    return NextResponse.json({ error: 'capacity' }, { status: 409 });
  }

  const record = await getApplication(actor, id);
  if (!record) return notFound();
  return NextResponse.json(toApplicationView(record), { status: 200 });
}
