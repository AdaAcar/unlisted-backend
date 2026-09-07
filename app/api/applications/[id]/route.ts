import { NextResponse, type NextRequest } from 'next/server';

import { getApplication, lockApplication, recordAuditEntry, withdrawApplication } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toApplicationView } from '@/views';

import { applicationContext, forbidden, notFound } from '../context';

/**
 * `GET /applications/:id` (docs/api.md Applications): applicant members, or the
 * host circle lead. One `ApplicationView` for both audiences — F1 forks it if a
 * real divergence appears. A rejected application shows `state: 'rejected'` and
 * nothing about why or about any other applicant (§3).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = await applicationContext(request, id);
  if (!result.ok) return result.response;
  const { actor, application, isApplicantMember, hostFacts } = result.ctx;

  if (
    policy(actor, 'application.get', {
      isApplicantMember,
      isHostLead: hostFacts.actorRole === 'lead',
    }) !== 'allow'
  ) {
    return forbidden();
  }
  return NextResponse.json(toApplicationView(application), { status: 200 });
}

/**
 * `DELETE /applications/:id` (docs/api.md Applications): the applicant lead
 * (or solo applicant) withdraws the whole application, before invitation.
 * Once invited/accepted the path is `POST /invitations/:id/decline`; terminal
 * applications return 409.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = await applicationContext(request, id);
  if (!result.ok) return result.response;
  const { actor, isInvitee } = result.ctx;

  // `application.delete` is lead-only; `isInvitee` is the solo user or the
  // active applicant-circle lead — the same party that may withdraw.
  if (policy(actor, 'application.delete', { actorRole: isInvitee ? 'lead' : null }) !== 'allow') {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const locked = await lockApplication(executor, id);
    if (!locked) return 'gone' as const;
    const res = await withdrawApplication(executor, locked, now);
    if (res === 'withdrawn') {
      await recordAuditEntry(executor, actor, {
        action: 'application_withdraw',
        actorRole: 'user',
        resourceId: id,
        resourceType: 'application',
        beforeState: { state: locked.state },
        afterState: { state: 'withdrawn' },
        ipHash,
        userAgentHash,
      });
    }
    return res;
  });

  if (outcome === 'gone') return notFound();
  if (outcome === 'not_withdrawable') {
    return NextResponse.json({ error: 'not_withdrawable' }, { status: 409 });
  }

  const record = await getApplication(actor, id);
  return NextResponse.json(record ? toApplicationView(record) : { state: 'withdrawn' }, {
    status: 200,
  });
}
