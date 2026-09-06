import { NextResponse, type NextRequest } from 'next/server';

import { circles, getSessionActor } from '@/db';
import type { CircleMembershipFacts } from '@/db/repositories/circles';
import type { UserActor } from '@/db/scope/actor';

/**
 * Shared preamble for the four `/circles/:id/*` handlers (C1): resolve the
 * session actor, then load the actor's own relationship to the circle so the
 * handler can 404 a non-member (agent-rules section 3 — a non-member must not
 * distinguish "exists, not mine" from "no such circle") before `policy()`
 * decides allow vs 403 among the cases that are visible.
 */
export type CircleContext =
  | { ok: true; actor: UserActor; facts: CircleMembershipFacts }
  | { ok: false; response: NextResponse };

export async function circleContext(
  request: NextRequest,
  circleId: string,
): Promise<CircleContext> {
  const actor = await getSessionActor(request);
  if (!actor) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }),
    };
  }
  const facts = await circles.membershipFacts(actor, circleId);
  return { ok: true, actor, facts };
}

export const notFound = (): NextResponse =>
  NextResponse.json({ error: 'not_found' }, { status: 404 });

export const forbidden = (): NextResponse =>
  NextResponse.json({ error: 'forbidden' }, { status: 403 });
