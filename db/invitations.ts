import { sql } from 'drizzle-orm';

import type { Ulid } from '@/db/scope/actor';
import type { ActorTransaction } from '@/db/scope/scoped';
import type { LockedApplication } from '@/db/applications';
import type { LockedPlan } from '@/db/plans';
import {
  transitionPlannedApplication,
  type PlannedApplicationSnapshot,
} from '@/domain/application-planned';
import { transitionPlan, type PlanSnapshot } from '@/domain/plan';
import { DomainError } from '@/domain/types';

/**
 * The capacity-affecting invitation path (C6 invite, C7a accept / decline, and
 * the E1 release helper). Every function here runs inside the caller's
 * `withActor` transaction with the plan already locked `FOR UPDATE` (§3 —
 * never read-then-write). Every state decision goes through the A6 reducers:
 * `transitionPlannedApplication` for the application, `transitionPlan` for the
 * plan's `held_count` / `accepted_guest_count` / `viable_at`. Nothing here
 * re-derives the capacity ceiling or the viability latch — the reducer does,
 * and the DB `plan_capacity_ceiling_chk` CHECK is the backstop under it.
 *
 * `plan.held_count` is an ownership-less aggregate: an accept converts *a*
 * hold, not necessarily the one placed for this application. Capacity stays
 * correct; per-hold attribution does not exist. E1's expiry worker must not
 * assume a released hold belongs to the application it is expiring (see
 * docs/state.md Known gaps C7a).
 *
 * In `TRUSTED_DATABASE_FILES` for the raw `executor.execute`.
 */

interface InvitedMember {
  userId: string;
  invitationState: string;
}

async function circleMemberIds(
  executor: ActorTransaction,
  applicationId: Ulid,
): Promise<InvitedMember[]> {
  return (
    await executor.execute(sql`
      SELECT user_id AS "userId", invitation_state AS "invitationState"
        FROM application_member
       WHERE application_id = ${applicationId}
       ORDER BY user_id
    `)
  ).rows as unknown as InvitedMember[];
}

function planSnapshot(plan: LockedPlan): PlanSnapshot {
  return {
    state: plan.state,
    mode: plan.mode,
    startsAt: plan.startsAt,
    openSpots: plan.openSpots,
    confirmedHostCount: plan.confirmedHostCount,
    acceptedGuestCount: plan.acceptedGuestCount,
    heldCount: plan.heldCount,
    viableAt: plan.viableAt,
    applicationsClosedAt: plan.applicationsClosedAt,
    cancellationKind: plan.cancellationKind,
  };
}

function appSnapshot(application: LockedApplication): PlannedApplicationSnapshot {
  return {
    state: application.state as PlannedApplicationSnapshot['state'],
    isSolo: application.soloUserId !== null,
    allMembersConfirmed: false,
    responseDeadline: null,
  };
}

// ---------------------------------------------------------------------------
// Invite (C6) — host lead places soft holds
// ---------------------------------------------------------------------------

export type InviteOutcome =
  | { outcome: 'invited'; responseDeadline: Date }
  | { outcome: 'partial' }
  | { outcome: 'capacity' }
  | { outcome: 'not_invitable' };

/**
 * `POST /applications/:id/invite`. `memberUserIds` names the subset to invite;
 * `null` / empty means the whole circle. A full invite moves the application to
 * `invited`, computes the response deadline, and places one hold per invited
 * member. A partial invite returns the application to `awaiting_confirmation`
 * with every confirmation voided and no holds placed — the smaller group must
 * re-confirm and the host re-shortlist before it can be invited again.
 */
export async function inviteApplication(
  executor: ActorTransaction,
  plan: LockedPlan,
  application: LockedApplication,
  memberUserIds: readonly Ulid[] | null,
  now: Date,
): Promise<InviteOutcome> {
  if (application.mode !== 'planned') return { outcome: 'not_invitable' };

  const isCircle = application.applicantCircleId !== null;
  const members = isCircle ? await circleMemberIds(executor, application.id) : [];
  const includedIds = members.map((m) => m.userId);
  const includedCount = isCircle ? includedIds.length : 1;

  let invitedIds: string[];
  if (isCircle) {
    invitedIds =
      memberUserIds && memberUserIds.length > 0 ? [...new Set(memberUserIds)] : includedIds;
    if (!invitedIds.every((id) => includedIds.includes(id))) return { outcome: 'not_invitable' };
  } else {
    invitedIds = [];
  }
  const invitedCount = isCircle ? invitedIds.length : 1;

  let appNext;
  try {
    appNext = transitionPlannedApplication(appSnapshot(application), {
      type: 'invite',
      invitedCount,
      includedCount,
      startsAt: plan.startsAt,
      now,
    });
  } catch (error) {
    if (error instanceof DomainError) return { outcome: 'not_invitable' };
    throw error;
  }

  if (appNext.state === 'awaiting_confirmation') {
    // Partial invite — no plan change, everyone must re-consent.
    await executor.execute(sql`
      UPDATE application SET state = 'awaiting_confirmation', response_deadline = NULL
       WHERE id = ${application.id}
    `);
    await executor.execute(sql`
      UPDATE application_member
         SET confirmation_state = 'unconfirmed', confirmed_version_hash = NULL,
             invitation_state = 'not_invited', hold_expires_at = NULL
       WHERE application_id = ${application.id}
    `);
    return { outcome: 'partial' };
  }

  // Full invite — place the holds under the plan lock.
  let planNext;
  try {
    planNext = transitionPlan(planSnapshot(plan), { type: 'invite', count: invitedCount, now });
  } catch (error) {
    if (error instanceof DomainError) return { outcome: 'capacity' };
    throw error;
  }

  const deadline = appNext.responseDeadline as Date;
  await executor.execute(sql`
    UPDATE plan SET held_count = ${planNext.heldCount} WHERE id = ${plan.id}
  `);
  await executor.execute(sql`
    UPDATE application SET state = 'invited', response_deadline = ${deadline}
     WHERE id = ${application.id}
  `);
  if (isCircle) {
    await executor.execute(sql`
      UPDATE application_member
         SET invitation_state = 'invited', hold_expires_at = ${deadline}
       WHERE application_id = ${application.id}
         AND user_id IN (${sql.join(
           invitedIds.map((x) => sql`${x}`),
           sql`, `,
         )})
    `);
  }
  return { outcome: 'invited', responseDeadline: deadline };
}

// ---------------------------------------------------------------------------
// Accept (C7a)
// ---------------------------------------------------------------------------

export type AcceptOutcome =
  | { outcome: 'accepted'; viable: boolean; idempotent: boolean }
  | { outcome: 'not_invited' }
  | { outcome: 'overlap' }
  | { outcome: 'capacity' };

/**
 * `POST /invitations/:id/accept`. Idempotent from `accepted` (returns the same
 * result, no second effect). Rejects if the invitee already holds an accepted
 * spot on an overlapping plan. Converts the holds to accepted guests under the
 * plan lock; the viability latch fires normally if this is the third confirmed
 * attendee (C7c wires the thread; here only `viable_at` + the introduction
 * ledger move).
 *
 * Write order: application + member rows first, THEN the plan — so the plan's
 * `reconcile_introductions_from_plan` trigger sees `state = 'accepted'` /
 * `invitation_state = 'accepted'` when it populates the ledger on a latch.
 */
export async function acceptInvitation(
  executor: ActorTransaction,
  plan: LockedPlan,
  application: LockedApplication,
  now: Date,
): Promise<AcceptOutcome> {
  if (application.state === 'accepted') {
    return { outcome: 'accepted', viable: plan.viableAt !== null, idempotent: true };
  }
  if (application.state !== 'invited') return { outcome: 'not_invited' };

  const isCircle = application.applicantCircleId !== null;
  const members = isCircle ? await circleMemberIds(executor, application.id) : [];
  const invitedIds = members.filter((m) => m.invitationState === 'invited').map((m) => m.userId);
  const count = isCircle ? invitedIds.length : 1;
  const subjectIds = isCircle ? invitedIds : [application.soloUserId as string];

  for (const userId of subjectIds) {
    const overlap = (
      await executor.execute(sql`
        SELECT app_user_has_overlapping_accepted_plan(
          ${userId}, ${plan.startsAt}, ${plan.endsAt}, ${application.id}
        ) AS "hit"
      `)
    ).rows[0] as { hit: boolean };
    if (overlap.hit) return { outcome: 'overlap' };
  }

  // Both reducer calls first: a capacity failure must leave zero writes.
  transitionPlannedApplication(appSnapshot(application), { type: 'accept', now });
  let planNext;
  try {
    planNext = transitionPlan(planSnapshot(plan), { type: 'acceptInvitation', count, now });
  } catch (error) {
    if (error instanceof DomainError) return { outcome: 'capacity' };
    throw error;
  }

  await executor.execute(sql`
    UPDATE application SET state = 'accepted', decided_at = ${now} WHERE id = ${application.id}
  `);
  if (isCircle) {
    await executor.execute(sql`
      UPDATE application_member SET invitation_state = 'accepted', hold_expires_at = NULL
       WHERE application_id = ${application.id} AND invitation_state = 'invited'
    `);
  }
  await executor.execute(sql`
    UPDATE plan
       SET held_count = ${planNext.heldCount},
           accepted_guest_count = ${planNext.acceptedGuestCount},
           viable_at = ${planNext.viableAt}
     WHERE id = ${plan.id}
  `);
  return { outcome: 'accepted', viable: planNext.viableAt !== null, idempotent: false };
}

// ---------------------------------------------------------------------------
// Decline (C7a) and expiry (E1 release path)
// ---------------------------------------------------------------------------

export type DeclineOutcome =
  | { outcome: 'declined'; idempotent: boolean }
  | { outcome: 'not_invited' };

/**
 * `POST /invitations/:id/decline`. Idempotent from `declined`. Releases the
 * holds under the plan lock. Write order: plan first (while the application is
 * still `invited`, so `app_actor_has_capacity_stake_in_plan` in
 * `plan_app_capacity_update`'s WITH CHECK still passes), then the application.
 */
export async function declineInvitation(
  executor: ActorTransaction,
  plan: LockedPlan,
  application: LockedApplication,
  now: Date,
): Promise<DeclineOutcome> {
  if (application.state === 'declined') return { outcome: 'declined', idempotent: true };
  if (application.state !== 'invited') return { outcome: 'not_invited' };
  return releaseHold(executor, plan, application, 'decline', now);
}

/**
 * E1's invitation/hold expiry persist path — no HTTP route (docs/api.md has
 * none; the scheduled worker in todo_agent.md E1 is the only caller). C7a
 * builds and tests it directly, the same "nothing calls it yet" shape as
 * `db/plans.ts`'s `completePlan`.
 */
export async function expireInvitation(
  executor: ActorTransaction,
  plan: LockedPlan,
  application: LockedApplication,
  now: Date,
): Promise<DeclineOutcome> {
  if (application.state === 'expired') return { outcome: 'declined', idempotent: true };
  if (application.state !== 'invited') return { outcome: 'not_invited' };
  return releaseHold(executor, plan, application, 'expire', now);
}

async function releaseHold(
  executor: ActorTransaction,
  plan: LockedPlan,
  application: LockedApplication,
  kind: 'decline' | 'expire',
  now: Date,
): Promise<DeclineOutcome> {
  const isCircle = application.applicantCircleId !== null;
  const members = isCircle ? await circleMemberIds(executor, application.id) : [];
  const count = isCircle ? members.filter((m) => m.invitationState === 'invited').length : 1;

  transitionPlannedApplication(appSnapshot(application), {
    type: kind === 'decline' ? 'decline' : 'expire',
    now,
  });
  const planNext = transitionPlan(planSnapshot(plan), {
    type: kind === 'decline' ? 'declineInvitation' : 'expireInvitation',
    count,
    now,
  });

  await executor.execute(sql`
    UPDATE plan SET held_count = ${planNext.heldCount} WHERE id = ${plan.id}
  `);
  const nextState = kind === 'decline' ? 'declined' : 'expired';
  await executor.execute(sql`
    UPDATE application SET state = ${nextState}, decided_at = ${now} WHERE id = ${application.id}
  `);
  if (isCircle) {
    await executor.execute(sql`
      UPDATE application_member SET invitation_state = ${nextState}, hold_expires_at = NULL
       WHERE application_id = ${application.id} AND invitation_state = 'invited'
    `);
  }
  return { outcome: 'declined', idempotent: false };
}
