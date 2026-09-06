import { NextResponse, type NextRequest } from 'next/server';

import { closePlanApplications, lockPlan, plans, recordAuditEntry } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toPlanView } from '@/views';

import { forbidden, notFound, planContext } from '../../context';

/**
 * `POST /plans/:id/close` (docs/modes.md API deltas): host circle lead only.
 * The manual closure condition (`host_closed`) — valid only from `published`,
 * always moves the plan to `applications_closed` (docs/state.md Decisions A6).
 * The other two closure conditions (capacity filled, `starts_at`) are not
 * endpoints: capacity is C5/C7, and `starts_at` is the E1 worker.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const ctx = await planContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, facts } = ctx;

  if (policy(actor, 'plan.close', { actorRole: facts.actorRole }) !== 'allow') {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const locked = await lockPlan(executor, id);
    if (!locked) return 'gone' as const;

    const result = await closePlanApplications(executor, locked, now);
    if (result === 'closed') {
      await recordAuditEntry(executor, actor, {
        action: 'plan_close',
        actorRole: 'circle_lead',
        resourceId: id,
        resourceType: 'plan',
        beforeState: { state: locked.state },
        afterState: { state: 'applications_closed', trigger: 'host_closed' },
        ipHash,
        userAgentHash,
      });
    }
    return result;
  });

  if (outcome === 'gone') return notFound();
  if (outcome === 'not_open') {
    return NextResponse.json({ error: 'not_open' }, { status: 409 });
  }

  const record = await plans.get(actor, id);
  if (!record) return notFound();
  return NextResponse.json(toPlanView(record), { status: 200 });
}
