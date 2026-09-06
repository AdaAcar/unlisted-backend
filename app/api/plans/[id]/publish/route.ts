import { NextResponse, type NextRequest } from 'next/server';

import { activeHostMemberCount, lockPlan, plans, publishPlan, recordAuditEntry } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toPlanView } from '@/views';

import { forbidden, notFound, planContext } from '../../context';

/**
 * `POST /plans/:id/publish` (docs/api.md Plans; docs/modes.md): host circle
 * lead only. Computes and stores `mode` from `starts_at - now` and enforces
 * `host size + open_spots >= MIN_PLAN_TOTAL` — both inside `domain/plan.ts`'s
 * reducer, called under the plan row lock. `confirmed_host_count` is stamped
 * from the true active host membership; a host circle that alone meets
 * `MIN_PLAN_TOTAL` latches `viable_at` at publish (docs/state.md Decisions C3).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const ctx = await planContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, plan, facts } = ctx;

  if (policy(actor, 'plan.publish', { actorRole: facts.actorRole }) !== 'allow') {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const locked = await lockPlan(executor, id);
    if (!locked) return { kind: 'gone' as const };

    const hostSize = await activeHostMemberCount(executor, plan.hostCircleId);
    const result = await publishPlan(executor, locked, hostSize, now);
    if (!result.ok) return { kind: 'rejected' as const, reason: result.reason };

    await recordAuditEntry(executor, actor, {
      action: 'plan_publish',
      actorRole: 'circle_lead',
      resourceId: id,
      resourceType: 'plan',
      beforeState: { state: locked.state },
      afterState: {
        state: 'published',
        mode: result.mode,
        confirmedHostCount: hostSize,
        viable: result.viable,
      },
      ipHash,
      userAgentHash,
    });
    return { kind: 'published' as const };
  });

  if (outcome.kind === 'gone') return notFound();
  if (outcome.kind === 'rejected') {
    return NextResponse.json({ error: 'not_publishable', detail: outcome.reason }, { status: 422 });
  }

  const record = await plans.get(actor, id);
  if (!record) return notFound();
  return NextResponse.json(toPlanView(record), { status: 200 });
}
