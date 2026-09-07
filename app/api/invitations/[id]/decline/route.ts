import { NextResponse, type NextRequest } from 'next/server';

import {
  declineInvitation,
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
 * `POST /invitations/:id/decline` (docs/api.md Invitations; docs/modes.md):
 * `:id` is the `application` id whose state is `invited`. Invitee only, planned
 * mode only — 404 in tonight mode. Idempotent from `declined`. Releases the
 * soft holds under the plan row lock.
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
  if (policy(actor, 'invitation.decline', { planMode: application.mode, isInvitee }) !== 'allow') {
    return forbidden();
  }

  // Idempotent no-op: an already-declined invitation is nothing to release, so
  // it does not enter a capacity transaction (and cannot — the invitee's
  // capacity stake, `plan_app_capacity_update`, is gone once the application
  // leaves `invited`). A different terminal state is a 409.
  if (application.state === 'declined') {
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
    const res = await declineInvitation(executor, lockedPlan, lockedApp, now);
    if (res.outcome === 'declined' && !res.idempotent) {
      await recordAuditEntry(executor, actor, {
        action: 'invitation_decline',
        actorRole: 'user',
        resourceId: id,
        resourceType: 'application',
        beforeState: { state: 'invited' },
        afterState: { state: 'declined' },
        ipHash,
        userAgentHash,
      });
    }
    return { kind: 'done' as const, res };
  });

  if (outcome.kind === 'gone') return notFound();
  if (outcome.res.outcome === 'not_invited') {
    return NextResponse.json({ error: 'not_invited' }, { status: 409 });
  }

  const record = await getApplication(actor, id);
  if (!record) return notFound();
  return NextResponse.json(toApplicationView(record), { status: 200 });
}
