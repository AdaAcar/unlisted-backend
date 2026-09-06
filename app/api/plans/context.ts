import { NextResponse, type NextRequest } from 'next/server';

import { circles, getSessionActor, plans } from '@/db';
import type { CircleMembershipFacts } from '@/db/repositories/circles';
import type { PlanRecord } from '@/db/repositories/plans';
import type { UserActor } from '@/db/scope/actor';

/**
 * Shared preamble for the `/plans/:id/*` handlers (C3). Resolves the session
 * actor, loads the plan through the A3 actor-scoped read (published plans, or
 * any plan the actor's circle hosts — a draft is invisible to everyone else),
 * then loads the actor's role in the host circle so `policy()` can decide
 * allow vs 403 among the plans that are visible.
 *
 * A plan the actor may not see returns 404 — its existence is not disclosed
 * (agent-rules section 3). A host-circle member who is not the lead can see the
 * plan, so a lead-only action returns 403, not 404 (same split as C1's
 * `circleContext`).
 */
export type PlanContext =
  | { ok: true; actor: UserActor; plan: PlanRecord; facts: CircleMembershipFacts }
  | { ok: false; response: NextResponse };

export async function planContext(request: NextRequest, planId: string): Promise<PlanContext> {
  const actor = await getSessionActor(request);
  if (!actor) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }),
    };
  }

  const plan = await plans.get(actor, planId);
  if (!plan) return { ok: false, response: notFound() };

  const facts = await circles.membershipFacts(actor, plan.hostCircleId);
  return { ok: true, actor, plan, facts };
}

export const notFound = (): NextResponse =>
  NextResponse.json({ error: 'not_found' }, { status: 404 });

export const forbidden = (): NextResponse =>
  NextResponse.json({ error: 'forbidden' }, { status: 403 });
