import { NextResponse, type NextRequest } from 'next/server';

import { getApplication, lockApplication, recordAuditEntry, rejectApplication } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toApplicationView } from '@/views';

import { applicationContext, forbidden, notFound } from '../../context';

/**
 * `POST /applications/:id/reject` (docs/api.md Review): host circle lead only,
 * planned mode. The applicant sees a neutral outcome — `state: 'rejected'` and
 * nothing else; there is no reason field, and the audit body carries no text
 * (§3). No information about other applicants is exposed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const result = await applicationContext(request, id);
  if (!result.ok) return result.response;
  const { actor, application, hostFacts } = result.ctx;

  if (application.mode !== 'planned') return notFound();
  if (policy(actor, 'application.reject', { actorRole: hostFacts.actorRole }) !== 'allow') {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const locked = await lockApplication(executor, id);
    if (!locked) return 'gone' as const;
    const res = await rejectApplication(executor, locked, now);
    if (res === 'ok') {
      await recordAuditEntry(executor, actor, {
        action: 'application_reject',
        actorRole: 'circle_lead',
        resourceId: id,
        resourceType: 'application',
        beforeState: { state: locked.state },
        afterState: { state: 'rejected' },
        ipHash,
        userAgentHash,
      });
    }
    return res;
  });

  if (outcome === 'gone') return notFound();
  if (outcome === 'not_applicable') {
    return NextResponse.json({ error: 'not_applicable' }, { status: 409 });
  }

  const record = await getApplication(actor, id);
  if (!record) return notFound();
  return NextResponse.json(toApplicationView(record), { status: 200 });
}
