import { isValid as isUlid } from 'ulidx';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { recordAuditEntry, transferCircleLead } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';

import { circleContext, forbidden, notFound } from '../../context';

/**
 * `POST /circles/:id/lead` (docs/api.md Circles): current lead only, audited.
 * `transferCircleLead` locks the circle row and moves `circle.lead_user_id`
 * plus both `circle_member` role rows so `circle_one_active_lead` (migration
 * 0009) never sees zero or two active leads.
 */
const transferLeadBody = z.object({
  userId: z.string().refine(isUlid, 'must be a valid ulid'),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = transferLeadBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const ctx = await circleContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, facts } = ctx;

  if (facts.membershipStatus !== 'active') return notFound();
  if (policy(actor, 'circle.transferLead', { actorRole: facts.actorRole }) !== 'allow') {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const outcome = await withActor(actor, async (executor) => {
    const result = await transferCircleLead(executor, actor, id, parsed.data.userId);
    if (result === 'transferred') {
      await recordAuditEntry(executor, actor, {
        action: 'circle_transfer_lead',
        actorRole: 'circle_lead',
        resourceId: id,
        resourceType: 'circle',
        beforeState: { leadUserId: actor.id },
        afterState: { leadUserId: parsed.data.userId },
        ipHash,
        userAgentHash,
      });
    }
    return result;
  });

  if (outcome === 'not_a_member') {
    return NextResponse.json({ error: 'not_a_member' }, { status: 409 });
  }
  return new NextResponse(null, { status: 204 });
}
