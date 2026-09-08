/**
 * The plan state machine (task A6). Pure, no DB imports (agent-rules section 4).
 *
 * Encodes, per docs/modes.md and the recorded decisions in docs/state.md:
 *
 * - Publish feasibility: host size + open spots >= MIN_PLAN_TOTAL.
 * - Mode is computed once at publish and never written again -- structurally
 *   immutable, since no other action touches `mode`.
 * - The viability predicate and the `viable_at` latch: set on first crossing
 *   of MIN_PLAN_TOTAL, never cleared. Whether the plan proceeds is evaluated
 *   live at every count-affecting action and again at `starts_at`.
 * - The three application-closure conditions (capacity filled, host closes,
 *   starts_at reached), including the decided asymmetry: the first two always
 *   move the plan to `applications_closed`; closure at `starts_at` only stamps
 *   `applications_closed_at` and additionally cancels a non-viable plan --
 *   it never routes a viable plan through `applications_closed` on its way
 *   toward completion.
 * - The planned-mode invitation soft hold and its capacity ceiling
 *   (`accepted_guest_count + held_count <= open_spots`, mirroring the DB
 *   CHECK added in A2/0000) versus tonight mode's direct, hard spot
 *   consumption.
 */
import { config } from '@/lib/config';

import { DomainError, type PlanMode } from './types';

export type PlanState = 'draft' | 'published' | 'applications_closed' | 'completed' | 'cancelled';

export type CancellationKind = 'host' | 'non_viable';

export type ClosureTrigger = 'capacity_filled' | 'host_closed' | 'starts_at';

export interface PlanSnapshot {
  readonly state: PlanState;
  /** Null until publish; immutable thereafter. */
  readonly mode: PlanMode | null;
  readonly startsAt: Date;
  readonly openSpots: number;
  readonly confirmedHostCount: number;
  readonly acceptedGuestCount: number;
  /** Planned-mode invitation soft holds. Always 0 outside planned mode. */
  readonly heldCount: number;
  /** First-crossing timestamp. Latches; never cleared. */
  readonly viableAt: Date | null;
  readonly applicationsClosedAt: Date | null;
  readonly cancellationKind: CancellationKind | null;
}

export type PlanAction =
  | { type: 'publish'; hostSize: number; now: Date }
  | { type: 'invite'; count: number; now: Date }
  | { type: 'declineInvitation'; count: number; now: Date }
  | { type: 'expireInvitation'; count: number; now: Date }
  | { type: 'acceptInvitation'; count: number; now: Date }
  | { type: 'approve'; count: number; now: Date }
  | { type: 'withdrawGuest'; count: number; now: Date }
  | { type: 'setHostCount'; confirmedHostCount: number; now: Date }
  | { type: 'close'; trigger: ClosureTrigger; now: Date }
  | { type: 'cancel'; now: Date }
  | { type: 'complete'; now: Date };

export function confirmedTotal(
  snapshot: Pick<PlanSnapshot, 'confirmedHostCount' | 'acceptedGuestCount'>,
): number {
  return snapshot.confirmedHostCount + snapshot.acceptedGuestCount;
}

export function canPublish(hostSize: number, openSpots: number): boolean {
  return hostSize + openSpots >= config.MIN_PLAN_TOTAL;
}

export function computeMode(startsAt: Date, now: Date): PlanMode {
  const hours = (startsAt.getTime() - now.getTime()) / (1000 * 60 * 60);
  return hours >= config.SPONTANEOUS_THRESHOLD_H ? 'planned' : 'tonight';
}

/**
 * Decision B (docs/state.md Decisions C7b + C7c): a plan is viable only when
 * `confirmed host members + accepted guests >= MIN_PLAN_TOTAL` AND at least one
 * of those is an accepted guest. A host circle meeting itself (guests = 0) is
 * not a plan that came together. Strictly stricter than docs/modes.md's rule —
 * it never weakens the invariant. Takes the same snapshot shape `confirmedTotal`
 * does, so there is no argument-order footgun.
 */
export function isViable(
  snapshot: Pick<PlanSnapshot, 'confirmedHostCount' | 'acceptedGuestCount'>,
): boolean {
  return confirmedTotal(snapshot) >= config.MIN_PLAN_TOTAL && snapshot.acceptedGuestCount >= 1;
}

/** The latch: never clears once set; latches to `now` on first crossing. */
export function computeViableAt(
  currentViableAt: Date | null,
  snapshot: Pick<PlanSnapshot, 'confirmedHostCount' | 'acceptedGuestCount'>,
  now: Date,
): Date | null {
  if (currentViableAt !== null) return currentViableAt;
  return isViable(snapshot) ? now : null;
}

function requireState(snapshot: PlanSnapshot, allowed: readonly PlanState[]): void {
  if (!allowed.includes(snapshot.state)) {
    throw new DomainError(`invalid transition from plan state "${snapshot.state}"`);
  }
}

function requireMode(snapshot: PlanSnapshot, mode: PlanMode): void {
  if (snapshot.mode !== mode) {
    throw new DomainError(`action not valid in mode "${String(snapshot.mode)}"`);
  }
}

function assertNonNegative(n: number, label: string): void {
  if (n < 0) throw new DomainError(`${label} cannot go negative`);
}

/** Recomputes the latch and enforces the capacity ceiling after any count change. */
function withRecomputedViability(snapshot: PlanSnapshot, now: Date): PlanSnapshot {
  if (snapshot.acceptedGuestCount + snapshot.heldCount > snapshot.openSpots) {
    throw new DomainError('capacity ceiling exceeded: accepted + held over open spots');
  }
  const viableAt = computeViableAt(snapshot.viableAt, snapshot, now);
  return { ...snapshot, viableAt };
}

function applyClosure(snapshot: PlanSnapshot, trigger: ClosureTrigger, now: Date): PlanSnapshot {
  const applicationsClosedAt = snapshot.applicationsClosedAt ?? now;

  if (trigger === 'starts_at') {
    if (!isViable(snapshot)) {
      return {
        ...snapshot,
        applicationsClosedAt,
        state: 'cancelled',
        cancellationKind: 'non_viable',
      };
    }
    // Viable: closure at starts_at skips `applications_closed` and leaves the
    // plan exactly where it was, ready for a later `complete`.
    return { ...snapshot, applicationsClosedAt };
  }

  // capacity_filled / host_closed: closing is a one-time event before the
  // plan has already closed by some other route.
  if (snapshot.state !== 'published') {
    throw new DomainError(
      `cannot close applications from state "${snapshot.state}" via "${trigger}"`,
    );
  }
  return { ...snapshot, applicationsClosedAt, state: 'applications_closed' };
}

export function transitionPlan(snapshot: PlanSnapshot, action: PlanAction): PlanSnapshot {
  switch (action.type) {
    case 'publish': {
      requireState(snapshot, ['draft']);
      if (action.now.getTime() >= snapshot.startsAt.getTime()) {
        throw new DomainError('cannot publish a plan whose start has already passed');
      }
      if (!canPublish(action.hostSize, snapshot.openSpots)) {
        throw new DomainError('plan is not feasible: host size + open spots below MIN_PLAN_TOTAL');
      }
      return {
        ...snapshot,
        state: 'published',
        mode: computeMode(snapshot.startsAt, action.now),
      };
    }

    case 'invite': {
      requireMode(snapshot, 'planned');
      requireState(snapshot, ['published']);
      return withRecomputedViability(
        { ...snapshot, heldCount: snapshot.heldCount + action.count },
        action.now,
      );
    }

    case 'declineInvitation':
    case 'expireInvitation': {
      requireMode(snapshot, 'planned');
      requireState(snapshot, ['published', 'applications_closed']);
      const heldCount = snapshot.heldCount - action.count;
      assertNonNegative(heldCount, 'held_count');
      return withRecomputedViability({ ...snapshot, heldCount }, action.now);
    }

    case 'acceptInvitation': {
      requireMode(snapshot, 'planned');
      requireState(snapshot, ['published', 'applications_closed']);
      const heldCount = snapshot.heldCount - action.count;
      assertNonNegative(heldCount, 'held_count');
      return withRecomputedViability(
        {
          ...snapshot,
          heldCount,
          acceptedGuestCount: snapshot.acceptedGuestCount + action.count,
        },
        action.now,
      );
    }

    case 'approve': {
      requireMode(snapshot, 'tonight');
      requireState(snapshot, ['published', 'applications_closed']);
      return withRecomputedViability(
        { ...snapshot, acceptedGuestCount: snapshot.acceptedGuestCount + action.count },
        action.now,
      );
    }

    case 'withdrawGuest': {
      requireState(snapshot, ['published', 'applications_closed']);
      const acceptedGuestCount = snapshot.acceptedGuestCount - action.count;
      assertNonNegative(acceptedGuestCount, 'accepted_guest_count');
      return withRecomputedViability({ ...snapshot, acceptedGuestCount }, action.now);
    }

    case 'setHostCount': {
      requireState(snapshot, ['published', 'applications_closed']);
      assertNonNegative(action.confirmedHostCount, 'confirmed_host_count');
      return withRecomputedViability(
        { ...snapshot, confirmedHostCount: action.confirmedHostCount },
        action.now,
      );
    }

    case 'close': {
      requireState(snapshot, ['published', 'applications_closed']);
      return applyClosure(snapshot, action.trigger, action.now);
    }

    case 'cancel': {
      requireState(snapshot, ['draft', 'published', 'applications_closed']);
      return { ...snapshot, state: 'cancelled', cancellationKind: 'host' };
    }

    case 'complete': {
      requireState(snapshot, ['published', 'applications_closed']);
      if (action.now.getTime() < snapshot.startsAt.getTime()) {
        throw new DomainError('cannot complete a plan before it starts');
      }
      if (!isViable(snapshot)) {
        throw new DomainError('cannot complete a non-viable plan');
      }
      return { ...snapshot, state: 'completed' };
    }
  }
}
