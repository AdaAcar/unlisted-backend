import { NextResponse, type NextRequest } from 'next/server';

import {
  getApplication,
  lockApplication,
  recordAuditEntry,
  shortlistApplication,
  unshortlistApplication,
} from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toApplicationView } from '@/views';

import { applicationContext, forbidden, notFound } from '../../context';

/**
 * `POST /applications/:id/shortlist` shortlists; `DELETE` un-shortlists
 * (docs/api.md Review: "Reversible"). Host circle lead only, planned mode. Both
 * are the `application.shortlist` policy action.
 */
async function handle(
  request: NextRequest,
  id: string,
  direction: 'shortlist' | 'unshortlist',
): Promise<NextResponse> {
  const result = await applicationContext(request, id);
  if (!result.ok) return result.response;
  const { actor, application, hostFacts } = result.ctx;

  if (application.mode !== 'planned') return notFound();
  if (policy(actor, 'application.shortlist', { actorRole: hostFacts.actorRole }) !== 'allow') {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const now = new Date();
  const outcome = await withActor(actor, async (executor) => {
    const locked = await lockApplication(executor, id);
    if (!locked) return 'gone' as const;
    const res =
      direction === 'shortlist'
        ? await shortlistApplication(executor, locked, now)
        : await unshortlistApplication(executor, locked, now);
    if (res === 'ok') {
      await recordAuditEntry(executor, actor, {
        action: `application_${direction}`,
        actorRole: 'circle_lead',
        resourceId: id,
        resourceType: 'application',
        beforeState: { state: locked.state },
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(request, (await params).id, 'shortlist');
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(request, (await params).id, 'unshortlist');
}
