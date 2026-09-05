import { NextResponse, type NextRequest } from 'next/server';

import { completeVerification, recordAuditEntry } from '@/db';
import { SYSTEM_ACTOR } from '@/db/scope/actor';
import { withActor } from '@/db/scope/scoped';
import { hashIdentity } from '@/lib/identityHash';
import { getVerificationVendor, type VerificationOutcome } from '@/lib/verificationVendor';
import { policy } from '@/policy';

/**
 * `POST /verification/webhook` (docs/api.md Verification): "Signature
 * verified before parsing the body." The raw body is read with `.text()`,
 * never `.json()` — a framework body parser would parse before the
 * signature has been checked, exactly what this must not do. The signature
 * is verified against that raw text; only once it passes does anything
 * touch `JSON.parse`.
 *
 * `verification.webhook`'s policy rule is an unconditional allow (A5: its
 * `docs/api.md` Auth column is "vendor signature", not a session) — the
 * call below is so authorization is never inlined here, not a gate. The
 * real gate is the signature check that follows.
 */

const GENERIC_FAILURE = { error: 'invalid_request' } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  policy(null, 'verification.webhook', {});

  const rawBody = await request.text();
  const vendor = getVerificationVendor();

  if (!vendor.verifyWebhookSignature(rawBody, request.headers)) {
    return NextResponse.json(GENERIC_FAILURE, { status: 401 });
  }

  let outcome: VerificationOutcome;
  try {
    outcome = vendor.parseWebhookPayload(rawBody);
  } catch {
    return NextResponse.json(GENERIC_FAILURE, { status: 400 });
  }

  const verified = outcome.verificationState === 'verified';
  const identityHash =
    verified && outcome.identityReference !== undefined
      ? hashIdentity(outcome.identityReference)
      : null;
  const age = verified ? (outcome.age ?? null) : null;

  const userId = await withActor(SYSTEM_ACTOR, async (executor) => {
    const matchedUserId = await completeVerification(executor, {
      vendorSessionRef: outcome.vendorSessionRef,
      verificationState: outcome.verificationState,
      age,
      identityHash,
    });
    if (matchedUserId) {
      await recordAuditEntry(executor, SYSTEM_ACTOR, {
        action: 'verification_complete',
        actorRole: 'system',
        resourceId: matchedUserId,
        resourceType: 'user',
      });
    }
    return matchedUserId;
  });

  // No matching pending session and an identity_hash collision both land
  // here, identically — the caller cannot tell which check failed
  // (todo_agent.md B2: generic failure messages).
  if (!userId) return NextResponse.json(GENERIC_FAILURE, { status: 400 });

  return new NextResponse(null, { status: 204 });
}
