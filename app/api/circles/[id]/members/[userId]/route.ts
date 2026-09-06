import { NextResponse, type NextRequest } from 'next/server';

import { recordAuditEntry, removeCircleMember } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';

import { circleContext, forbidden, notFound } from '../../../context';

/**
 * `DELETE /circles/:id/members/:userId` (docs/api.md Circles): the lead
 * removes anyone; a member removes themselves. An invited member removing
 * their own row is how a pending invitation is declined — there is no
 * separate decline endpoint. Removal is soft (`status = 'removed'`).
 *
 * The sitting lead cannot remove themselves while still leading (the circle
 * would be left with no lead and no one able to act): 409, transfer first.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
): Promise<NextResponse> {
  const { id, userId } = await params;

  const ctx = await circleContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, facts } = ctx;

  // An active member sees the circle; an invited user may still act on their
  // own row (decline). Anything else -> 404.
  const canAct = facts.membershipStatus === 'active' || facts.membershipStatus === 'invited';
  if (!canAct) return notFound();

  const targetIsSelf = userId === actor.id;
  if (
    policy(actor, 'circle.removeMember', { actorRole: facts.actorRole, targetIsSelf }) !== 'allow'
  ) {
    return forbidden();
  }

  const actorIsLead = facts.membershipStatus === 'active' && facts.actorRole === 'lead';
  const { ipHash, userAgentHash } = auditMeta(request);
  const outcome = await withActor(actor, async (executor) => {
    const result = await removeCircleMember(executor, actor, id, userId, actorIsLead);
    if (result === 'removed') {
      await recordAuditEntry(executor, actor, {
        action: 'circle_member_remove',
        actorRole: actorIsLead && !targetIsSelf ? 'circle_lead' : 'user',
        resourceId: id,
        resourceType: 'circle',
        afterState: { userId, status: 'removed' },
        ipHash,
        userAgentHash,
      });
    }
    return result;
  });

  if (outcome === 'lead_must_transfer') {
    return NextResponse.json({ error: 'lead_must_transfer' }, { status: 409 });
  }
  if (outcome === 'not_a_member') return notFound();
  return new NextResponse(null, { status: 204 });
}
