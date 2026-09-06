import { NextResponse, type NextRequest } from 'next/server';

import { cancelPlan, lockPlan, plans, recordAuditEntry } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toPlanView } from '@/views';

import { forbidden, notFound, planContext } from '../../context';

/**
 * `POST /plans/:id/cancel` (docs/api.md Plans): host circle lead only. Host
 * cancellation (`cancellation_kind = 'host'`), valid from `draft`,
 * `published`, or `applications_closed`. A plan already `completed` or
 * `cancelled` returns 409.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const ctx = await planContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, facts } = ctx;

  if (policy(actor, 'plan.cancel', { actorRole: facts.actorRole }) !== 'allow') {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const locked = await lockPlan(executor, id);
    if (!locked) return 'gone' as const;

    const result = await cancelPlan(executor, locked, now);
    if (result === 'cancelled') {
      await recordAuditEntry(executor, actor, {
        action: 'plan_cancel',
        actorRole: 'circle_lead',
        resourceId: id,
        resourceType: 'plan',
        beforeState: { state: locked.state },
        afterState: { state: 'cancelled', cancellationKind: 'host' },
        ipHash,
        userAgentHash,
      });
    }
    return result;
  });

  if (outcome === 'gone') return notFound();
  if (outcome === 'not_cancellable') {
    return NextResponse.json({ error: 'not_cancellable' }, { status: 409 });
  }

  const record = await plans.get(actor, id);
  if (!record) return notFound();
  return NextResponse.json(toPlanView(record), { status: 200 });
}
