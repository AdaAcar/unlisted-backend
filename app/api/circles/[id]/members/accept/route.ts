import { NextResponse, type NextRequest } from 'next/server';

import { acceptCircleInvitation, recordAuditEntry } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';

import { circleContext, notFound } from '../../../context';

/**
 * `POST /circles/:id/members/accept` — the invitee accepting their own
 * invitation. docs/api.md states "Invitee must accept" as a rule on the
 * lead-only invite row but gives it no endpoint; this is that endpoint (see
 * `INFERRED_ENDPOINTS` in policy/actions.ts and docs/state.md Decisions C1).
 * Anyone whose membership is not `invited` — non-member, already active,
 * removed — gets 404.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const ctx = await circleContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, facts } = ctx;

  if (facts.membershipStatus !== 'invited') return notFound();
  if (
    policy(actor, 'circle.acceptInvitation', { membershipStatus: facts.membershipStatus }) !==
    'allow'
  ) {
    return notFound();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const accepted = await withActor(actor, async (executor) => {
    const ok = await acceptCircleInvitation(executor, actor, id);
    if (ok) {
      await recordAuditEntry(executor, actor, {
        action: 'circle_member_accept',
        actorRole: 'user',
        resourceId: id,
        resourceType: 'circle',
        afterState: { userId: actor.id, status: 'active' },
        ipHash,
        userAgentHash,
      });
    }
    return ok;
  });

  if (!accepted) return notFound();
  return new NextResponse(null, { status: 204 });
}
