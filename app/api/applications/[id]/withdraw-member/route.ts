import { NextResponse, type NextRequest } from 'next/server';

import { getApplication, lockApplication, recordAuditEntry, withdrawMember } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toApplicationView } from '@/views';

import { applicationContext, forbidden, notFound } from '../../context';

/**
 * `POST /applications/:id/withdraw-member` (docs/api.md Applications): the
 * member themselves removes their own row. Triggers re-confirmation (the
 * remaining group drops back to `awaiting_confirmation`, every confirmation
 * voided) or invalidation (the set falls below `min_group_size` → the whole
 * application is withdrawn). Planned circle applications only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const result = await applicationContext(request, id);
  if (!result.ok) return result.response;
  const { actor, application, plan, isApplicantMember } = result.ctx;

  if (application.mode !== 'planned' || application.applicantCircleId === null) return notFound();

  if (
    policy(actor, 'application.withdrawMember', {
      isSelfMember: isApplicantMember && application.soloUserId === null,
    }) !== 'allow'
  ) {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const locked = await lockApplication(executor, id);
    if (!locked) return { kind: 'gone' as const };
    const res = await withdrawMember(executor, locked, actor.id, plan.minGroupSize, now);
    if (res.ok) {
      await recordAuditEntry(executor, actor, {
        action: 'application_member_withdraw',
        actorRole: 'user',
        resourceId: id,
        resourceType: 'application',
        afterState: { outcome: res.outcome },
        ipHash,
        userAgentHash,
      });
    }
    return { kind: 'done' as const, res };
  });

  if (outcome.kind === 'gone') return notFound();
  if (!outcome.res.ok) {
    const status = outcome.res.reason === 'not_member' ? 403 : 409;
    return NextResponse.json({ error: outcome.res.reason }, { status });
  }

  const record = await getApplication(actor, id);
  return NextResponse.json(record ? toApplicationView(record) : { outcome: outcome.res.outcome }, {
    status: 200,
  });
}
