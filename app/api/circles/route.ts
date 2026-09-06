import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { createCircle, getSessionActor, recordAuditEntry } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toCircleView } from '@/views';

/**
 * `POST /circles` (docs/api.md Circles): session + verified. The creator
 * becomes the lead — `createCircle` writes the circle row and the creator's
 * (lead, active) membership in one transaction, audited alongside.
 */

const createCircleBody = z.object({
  name: z.string().trim().min(1).max(120),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = createCircleBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const actor = await getSessionActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (policy(actor, 'circle.create', {}) !== 'allow') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const created = await withActor(actor, async (executor) => {
    const circle = await createCircle(executor, actor, parsed.data.name);
    await recordAuditEntry(executor, actor, {
      action: 'circle_create',
      actorRole: 'user',
      resourceId: circle.id,
      resourceType: 'circle',
      afterState: { name: circle.name, leadUserId: circle.leadUserId },
      ipHash,
      userAgentHash,
    });
    return circle;
  });

  return NextResponse.json(
    toCircleView({
      id: created.id,
      name: created.name,
      leadUserId: created.leadUserId,
      memberIds: [created.leadUserId],
    }),
    { status: 201 },
  );
}
