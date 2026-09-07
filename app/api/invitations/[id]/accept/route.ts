import { NextResponse, type NextRequest } from 'next/server';

import {
  acceptInvitation,
  getApplication,
  lockApplication,
  lockPlan,
  recordAuditEntry,
} from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toApplicationView } from '@/views';

import { applicationContext, forbidden, notFound } from '../../../applications/context';

/**
 * `POST /invitations/:id/accept` (docs/api.md Invitations; docs/modes.md):
 * `:id` is the `application` id whose state is `invited`. Invitee only (the
 * solo user or the active applicant-circle lead) — planned mode only, **404 in
 * tonight mode**.
 *
 * Idempotent: a repeat from `accepted` returns the same result with no second
 * effect. Rejects on overlap with another accepted plan, and on capacity
 * overflow. Locks the plan row; the viability latch fires normally if this is
 * the third confirmed attendee (the thread itself is C7c).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const result = await applicationContext(request, id);
  if (!result.ok) return result.response;
  const { actor, application, plan, isInvitee } = result.ctx;

  if (application.mode !== 'planned') return notFound();
  if (policy(actor, 'invitation.accept', { planMode: application.mode, isInvitee }) !== 'allow') {
    return forbidden();
  }

  // Idempotent no-op: an already-accepted invitation returns the same result
  // without a second capacity transaction. A non-`invited` state that is not
  // `accepted` is a 409.
  if (application.state === 'accepted') {
    return NextResponse.json(toApplicationView(application), { status: 200 });
  }
  if (application.state !== 'invited') {
    return NextResponse.json({ error: 'not_invited' }, { status: 409 });
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const lockedPlan = await lockPlan(executor, plan.id);
    const lockedApp = await lockApplication(executor, id);
    if (!lockedPlan || !lockedApp) return { kind: 'gone' as const };
    const res = await acceptInvitation(executor, lockedPlan, lockedApp, now);
    if (res.outcome === 'accepted' && !res.idempotent) {
      await recordAuditEntry(executor, actor, {
        action: 'invitation_accept',
        actorRole: 'user',
        resourceId: id,
        resourceType: 'application',
        beforeState: { state: 'invited' },
        afterState: { state: 'accepted', viable: res.viable },
        ipHash,
        userAgentHash,
      });
    }
    return { kind: 'done' as const, res };
  });

  if (outcome.kind === 'gone') return notFound();
  const { res } = outcome;
  if (res.outcome === 'not_invited') {
    return NextResponse.json({ error: 'not_invited' }, { status: 409 });
  }
  if (res.outcome === 'overlap') {
    return NextResponse.json({ error: 'overlap' }, { status: 409 });
  }
  if (res.outcome === 'capacity') {
    return NextResponse.json({ error: 'capacity' }, { status: 409 });
  }

  const record = await getApplication(actor, id);
  if (!record) return notFound();
  return NextResponse.json(toApplicationView(record), { status: 200 });
}
