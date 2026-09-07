import { isValid as isUlid } from 'ulidx';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  getApplication,
  inviteApplication,
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
 * `POST /applications/:id/invite` (docs/api.md Review; docs/modes.md): host
 * circle lead only, **planned mode** — 404 in tonight mode. `memberUserIds`
 * names the subset to invite; omitted / empty means the whole circle.
 *
 * A full invite places one soft hold per invited member under the plan row
 * lock and computes the response deadline. A partial invite returns the circle
 * to `awaiting_confirmation` with every confirmation voided and no holds placed
 * — nobody is invited into a smaller group than they agreed to.
 */
const body = z.object({
  memberUserIds: z.array(z.string().refine(isUlid, 'must be a valid ulid')).max(50).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const parsed = body.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const result = await applicationContext(request, id);
  if (!result.ok) return result.response;
  const { actor, application, plan, hostFacts } = result.ctx;

  if (application.mode !== 'planned') return notFound();
  if (
    policy(actor, 'application.invite', {
      planMode: application.mode,
      actorRole: hostFacts.actorRole,
    }) !== 'allow'
  ) {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const lockedPlan = await lockPlan(executor, plan.id);
    const lockedApp = await lockApplication(executor, id);
    if (!lockedPlan || !lockedApp) return { kind: 'gone' as const };
    const res = await inviteApplication(
      executor,
      lockedPlan,
      lockedApp,
      parsed.data.memberUserIds ?? null,
      now,
    );
    if (res.outcome === 'invited' || res.outcome === 'partial') {
      await recordAuditEntry(executor, actor, {
        action: 'application_invite',
        actorRole: 'circle_lead',
        resourceId: id,
        resourceType: 'application',
        beforeState: { state: lockedApp.state },
        afterState: { outcome: res.outcome },
        ipHash,
        userAgentHash,
      });
    }
    return { kind: 'done' as const, res };
  });

  if (outcome.kind === 'gone') return notFound();
  const { res } = outcome;
  if (res.outcome === 'capacity') {
    return NextResponse.json({ error: 'capacity' }, { status: 409 });
  }
  if (res.outcome === 'not_invitable') {
    return NextResponse.json({ error: 'not_invitable' }, { status: 409 });
  }

  const record = await getApplication(actor, id);
  if (!record) return notFound();
  return NextResponse.json({ ...toApplicationView(record), invite: res.outcome }, { status: 200 });
}
