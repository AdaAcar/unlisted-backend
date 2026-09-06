import { isValid as isUlid } from 'ulidx';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { inviteMember, recordAuditEntry } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';

import { circleContext, forbidden, notFound } from '../../context';

/**
 * `POST /circles/:id/members` (docs/api.md Circles): lead only. The invitee
 * is written as an `invited` row and must accept separately
 * (`POST /circles/:id/members/accept`). A non-member gets 404; a member who
 * is not the lead gets 403.
 */
const addMemberBody = z.object({
  userId: z.string().refine(isUlid, 'must be a valid ulid'),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = addMemberBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const ctx = await circleContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, facts } = ctx;

  if (facts.membershipStatus !== 'active') return notFound();
  if (policy(actor, 'circle.addMember', { actorRole: facts.actorRole }) !== 'allow') {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const outcome = await withActor(actor, async (executor) => {
    const result = await inviteMember(executor, id, parsed.data.userId);
    if (result === 'invited') {
      await recordAuditEntry(executor, actor, {
        action: 'circle_member_invite',
        actorRole: 'circle_lead',
        resourceId: id,
        resourceType: 'circle',
        afterState: { userId: parsed.data.userId, status: 'invited' },
        ipHash,
        userAgentHash,
      });
    }
    return result;
  });

  if (outcome === 'unknown_user') {
    return NextResponse.json({ error: 'unknown_user' }, { status: 422 });
  }
  if (outcome === 'already_member') {
    return NextResponse.json({ error: 'already_member' }, { status: 409 });
  }
  return new NextResponse(null, { status: 204 });
}
