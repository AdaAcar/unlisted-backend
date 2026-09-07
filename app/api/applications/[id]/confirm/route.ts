import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { confirmMember, getApplication, lockApplication, recordAuditEntry } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toApplicationView } from '@/views';

import { applicationContext, forbidden, notFound } from '../../context';

/**
 * `POST /applications/:id/confirm` (docs/api.md Applications; docs/modes.md):
 * the confirming member only, planned mode only — **404 in tonight mode**. The
 * body names the version hash the member is confirming; the server checks it is
 * the current one (a stale hash → 409). When the last included member confirms,
 * the application auto-advances to `submitted` (there is no submit endpoint —
 * that is how "submission is blocked while any member is unconfirmed" holds).
 */
const body = z.object({ versionHash: z.string().regex(/^[0-9a-f]{64}$/) });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const result = await applicationContext(request, id);
  if (!result.ok) return result.response;
  const { actor, application, isApplicantMember } = result.ctx;

  // docs/modes.md: this endpoint does not exist in tonight mode.
  if (application.mode !== 'planned') return notFound();

  if (
    policy(actor, 'application.confirm', {
      planMode: application.mode,
      isConfirmingMember: isApplicantMember && application.applicantCircleId !== null,
    }) !== 'allow'
  ) {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const locked = await lockApplication(executor, id);
    if (!locked) return { kind: 'gone' as const };
    const res = await confirmMember(executor, locked, actor.id, parsed.data.versionHash, now);
    if (res.ok) {
      await recordAuditEntry(executor, actor, {
        action: 'application_confirm',
        actorRole: 'user',
        resourceId: id,
        resourceType: 'application',
        afterState: { confirmed: true, submitted: res.submitted },
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
  if (!record) return notFound();
  return NextResponse.json(toApplicationView(record), { status: 200 });
}
