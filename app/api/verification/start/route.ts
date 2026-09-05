import { NextResponse, type NextRequest } from 'next/server';

import { getSessionActor, recordAuditEntry, startVerification } from '@/db';
import { SYSTEM_ACTOR } from '@/db/scope/actor';
import { withActor } from '@/db/scope/scoped';
import { getVerificationVendor } from '@/lib/verificationVendor';
import { policy } from '@/policy';

/**
 * `POST /verification/start` (docs/api.md Verification): "Returns a vendor
 * session. No document ever touches our servers." The write that records
 * the vendor's session ref runs as a system actor, not the caller's own
 * user actor — migration 0008's trigger requires that for
 * verification_state/age/identity_hash/verification_ref regardless of who
 * triggered the request, so this is a system-actor write like the webhook's,
 * even though a real session is what authorized it.
 */

const GENERIC_FAILURE = { error: 'invalid_request' } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const actor = await getSessionActor(request);
  if (!actor || policy(actor, 'verification.start', {}) !== 'allow') {
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  const vendor = getVerificationVendor();
  const { vendorSessionRef } = await vendor.startSession(actor.id);

  await withActor(SYSTEM_ACTOR, async (executor) => {
    await startVerification(executor, actor.id, vendorSessionRef);
    await recordAuditEntry(executor, SYSTEM_ACTOR, {
      action: 'verification_start',
      actorRole: 'system',
      resourceId: actor.id,
      resourceType: 'user',
    });
  });

  return NextResponse.json({ vendorSessionRef }, { status: 200 });
}
