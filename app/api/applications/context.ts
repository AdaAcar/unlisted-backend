import { NextResponse, type NextRequest } from 'next/server';

import { applications, circles, getSessionActor, plans } from '@/db';
import type { ApplicationRecord } from '@/db/repositories/applications';
import type { CircleMembershipFacts } from '@/db/repositories/circles';
import type { PlanRecord } from '@/db/repositories/plans';
import type { UserActor } from '@/db/scope/actor';

/**
 * Shared preamble for the `/applications/:id/*` and `/invitations/:id/*`
 * handlers (C5 / C6 / C7a). Resolves the session actor, loads the application
 * through the A3-style RLS read (`app_application_visible` — solo applicant,
 * applicant member, active applicant-circle member, or any active host-circle
 * member), then loads the plan and the actor's role in both the host circle and
 * (for a circle application) the applicant circle, so `policy()` can decide
 * allow vs 403 among the applications that are visible.
 *
 * An application the actor may not see returns 404 — its existence is not
 * disclosed (§3). A member who is not the party a lead-only action needs gets
 * 403 (they already know it exists). Same split as C1 / C3.
 */
export interface ApplicationContext {
  actor: UserActor;
  application: ApplicationRecord;
  plan: PlanRecord;
  /** The actor's role in the plan's host circle. */
  hostFacts: CircleMembershipFacts;
  /** The actor's role in the applicant circle, or null for a solo application. */
  applicantFacts: CircleMembershipFacts | null;
  /** The actor is the solo applicant, or holds a member row. */
  isApplicantMember: boolean;
  /** The actor is the solo applicant, or the active lead of the applicant circle. */
  isInvitee: boolean;
}

export type ApplicationContextResult =
  | { ok: true; ctx: ApplicationContext }
  | { ok: false; response: NextResponse };

export async function applicationContext(
  request: NextRequest,
  applicationId: string,
): Promise<ApplicationContextResult> {
  const actor = await getSessionActor(request);
  if (!actor) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }),
    };
  }

  const application = await applications.get(actor, applicationId);
  if (!application) return { ok: false, response: notFound() };

  const plan = await plans.get(actor, application.planId);
  if (!plan) return { ok: false, response: notFound() };

  const hostFacts = await circles.membershipFacts(actor, plan.hostCircleId);
  const applicantFacts = application.applicantCircleId
    ? await circles.membershipFacts(actor, application.applicantCircleId)
    : null;

  const isApplicantMember =
    application.soloUserId === actor.id || application.members.some((m) => m.userId === actor.id);
  const isInvitee = application.soloUserId === actor.id || applicantFacts?.actorRole === 'lead';

  return {
    ok: true,
    ctx: { actor, application, plan, hostFacts, applicantFacts, isApplicantMember, isInvitee },
  };
}

export const notFound = (): NextResponse =>
  NextResponse.json({ error: 'not_found' }, { status: 404 });

export const forbidden = (): NextResponse =>
  NextResponse.json({ error: 'forbidden' }, { status: 403 });
