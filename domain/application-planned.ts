/**
 * The planned-mode application state machine (task A6). Pure, no DB imports.
 *
 * Partitions the shared `application_state` enum (db/schema/enums.ts) to
 * exactly the planned-mode subset the DB's mode-scoped CHECK also allows:
 * draft, awaiting_confirmation, submitted, shortlisted, invited, accepted,
 * declined, expired, rejected, withdrawn. `approved` (tonight-only) is not a
 * member of `PlannedApplicationState` at all -- unreachable by construction,
 * not merely by a runtime guard.
 *
 * Encodes, per docs/modes.md:
 *
 * - Member confirmation bound to a version hash, voided when the application
 *   changes (`voidStaleConfirmations`). This machine only performs the
 *   string-compare voiding rule -- computing/serializing the version hash
 *   itself is C5's concern, not A6's.
 * - Partial invitation returns the circle to `awaiting_confirmation` instead
 *   of `invited`, so nobody is invited into a smaller group than they agreed
 *   to without re-consenting.
 * - The response deadline clamp, computed at invitation time and never past
 *   `starts_at`.
 * - Shortlisting is reversible (`unshortlist`: shortlisted -> submitted),
 *   per docs/api.md's Review table. Added as a C6 amendment to this A6
 *   machine -- see docs/state.md Decisions (C6).
 */
import { config } from '@/lib/config';

import { DomainError, type Ulid } from './types';

export type PlannedApplicationState =
  | 'draft'
  | 'awaiting_confirmation'
  | 'submitted'
  | 'shortlisted'
  | 'invited'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'rejected'
  | 'withdrawn';

export interface PlannedApplicationSnapshot {
  readonly state: PlannedApplicationState;
  /** Solo applications have no members to confirm; the gate never applies. */
  readonly isSolo: boolean;
  /** Whether every included member currently holds a live confirmation. */
  readonly allMembersConfirmed: boolean;
  readonly responseDeadline: Date | null;
}

export type PlannedApplicationAction =
  | { type: 'submit'; now: Date }
  | { type: 'edit'; now: Date }
  | { type: 'shortlist'; now: Date }
  | { type: 'unshortlist'; now: Date }
  | { type: 'reject'; now: Date }
  | { type: 'invite'; invitedCount: number; includedCount: number; startsAt: Date; now: Date }
  | { type: 'accept'; now: Date }
  | { type: 'decline'; now: Date }
  | { type: 'expire'; now: Date }
  | { type: 'withdraw'; now: Date };

export interface MemberConfirmation {
  readonly userId: Ulid;
  readonly confirmed: boolean;
  readonly confirmedVersionHash: string | null;
}

/**
 * Voids any member confirmation whose hash no longer matches the
 * application's current version. A plain string compare -- the caller (C5)
 * computes and supplies `currentVersionHash`; this function never derives one.
 */
export function voidStaleConfirmations(
  members: readonly MemberConfirmation[],
  currentVersionHash: string,
): MemberConfirmation[] {
  return members.map((member) =>
    member.confirmedVersionHash === currentVersionHash
      ? member
      : { ...member, confirmed: false, confirmedVersionHash: null },
  );
}

/**
 * `deadline = clamp(MIN_M, (startsAt - now) * RATIO, MAX_H)`, then hard-capped
 * so it never lands past `starts_at`.
 */
export function computeResponseDeadline(now: Date, startsAt: Date): Date {
  const remainingMs = startsAt.getTime() - now.getTime();
  const floorMs = config.RESPONSE_DEADLINE_MIN_M * 60 * 1000;
  const ceilingMs = config.RESPONSE_DEADLINE_MAX_H * 60 * 60 * 1000;
  const rawMs = remainingMs * config.RESPONSE_DEADLINE_RATIO;
  const clampedMs = Math.min(Math.max(rawMs, floorMs), ceilingMs);
  const deadlineMs = Math.min(now.getTime() + clampedMs, startsAt.getTime());
  return new Date(deadlineMs);
}

function requireState(
  snapshot: PlannedApplicationSnapshot,
  allowed: readonly PlannedApplicationState[],
): void {
  if (!allowed.includes(snapshot.state)) {
    throw new DomainError(`invalid transition from application state "${snapshot.state}"`);
  }
}

export function transitionPlannedApplication(
  snapshot: PlannedApplicationSnapshot,
  action: PlannedApplicationAction,
): PlannedApplicationSnapshot {
  switch (action.type) {
    case 'submit': {
      requireState(snapshot, ['draft', 'awaiting_confirmation']);
      if (!snapshot.isSolo && !snapshot.allMembersConfirmed) {
        throw new DomainError('cannot submit while an included member is unconfirmed');
      }
      return { ...snapshot, state: 'submitted' };
    }

    case 'edit': {
      requireState(snapshot, ['draft', 'awaiting_confirmation', 'submitted', 'shortlisted']);
      // The version hash changes, so every existing confirmation is stale; the
      // caller re-derives member rows with voidStaleConfirmations and this
      // aggregate flag follows. An edit that lands after the application was
      // already submitted (or shortlisted) -- the only in-scope trigger is
      // `POST /applications/:id/withdraw-member` shrinking the member set --
      // knocks it back to `awaiting_confirmation`: the smaller group must
      // re-confirm and the host must re-shortlist. Added as a C5 amendment to
      // this A6 machine (see docs/state.md Decisions C5).
      const state =
        snapshot.state === 'submitted' || snapshot.state === 'shortlisted'
          ? 'awaiting_confirmation'
          : snapshot.state;
      return { ...snapshot, state, allMembersConfirmed: false };
    }

    case 'shortlist': {
      requireState(snapshot, ['submitted']);
      return { ...snapshot, state: 'shortlisted' };
    }

    case 'unshortlist': {
      // docs/api.md Review: shortlist is "Reversible". The inverse of
      // `shortlist` -- back to `submitted`, from where the host can shortlist
      // again, reject, or leave it.
      requireState(snapshot, ['shortlisted']);
      return { ...snapshot, state: 'submitted' };
    }

    case 'reject': {
      requireState(snapshot, ['submitted', 'shortlisted']);
      return { ...snapshot, state: 'rejected' };
    }

    case 'invite': {
      requireState(snapshot, ['shortlisted']);
      if (action.invitedCount > action.includedCount) {
        throw new DomainError('cannot invite more members than are included');
      }
      if (action.invitedCount < action.includedCount) {
        // Partial invitation: return to awaiting_confirmation for re-consent
        // from the smaller invited group. No response deadline yet -- one is
        // only computed once the (now smaller) group is actually invited.
        return {
          ...snapshot,
          state: 'awaiting_confirmation',
          allMembersConfirmed: false,
          responseDeadline: null,
        };
      }
      return {
        ...snapshot,
        state: 'invited',
        responseDeadline: computeResponseDeadline(action.now, action.startsAt),
      };
    }

    case 'accept': {
      requireState(snapshot, ['invited']);
      return { ...snapshot, state: 'accepted' };
    }

    case 'decline': {
      requireState(snapshot, ['invited']);
      return { ...snapshot, state: 'declined' };
    }

    case 'expire': {
      requireState(snapshot, ['invited']);
      return { ...snapshot, state: 'expired' };
    }

    case 'withdraw': {
      requireState(snapshot, [
        'draft',
        'awaiting_confirmation',
        'submitted',
        'shortlisted',
        'invited',
        'accepted',
      ]);
      return { ...snapshot, state: 'withdrawn' };
    }
  }
}
