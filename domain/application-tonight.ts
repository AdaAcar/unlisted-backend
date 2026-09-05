/**
 * The tonight-mode application state machine (task A6). Pure, no DB imports.
 *
 * Partitions the shared `application_state` enum to exactly the tonight
 * subset the DB's mode-scoped CHECK allows: submitted, approved, rejected,
 * withdrawn, expired. There is no invitation entity and no confirmation step
 * (docs/modes.md) -- `awaiting_confirmation`, `shortlisted`, `invited`,
 * `accepted`, and `declined` are not members of `TonightApplicationState` at
 * all, so they are unreachable by construction, not by a runtime guard.
 *
 * `approve` hard-consumes a spot directly (see domain/plan.ts's `approve`
 * action); there is no soft hold to place or release in this mode.
 */
import { DomainError } from './types';

export type TonightApplicationState =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'expired';

export interface TonightApplicationSnapshot {
  readonly state: TonightApplicationState;
}

export type TonightApplicationAction =
  | { type: 'approve'; now: Date }
  | { type: 'reject'; now: Date }
  | { type: 'withdraw'; now: Date }
  | { type: 'expire'; now: Date };

function requireState(
  snapshot: TonightApplicationSnapshot,
  allowed: readonly TonightApplicationState[],
): void {
  if (!allowed.includes(snapshot.state)) {
    throw new DomainError(`invalid transition from application state "${snapshot.state}"`);
  }
}

export function transitionTonightApplication(
  snapshot: TonightApplicationSnapshot,
  action: TonightApplicationAction,
): TonightApplicationSnapshot {
  switch (action.type) {
    case 'approve': {
      requireState(snapshot, ['submitted']);
      return { state: 'approved' };
    }

    case 'reject': {
      requireState(snapshot, ['submitted']);
      return { state: 'rejected' };
    }

    case 'expire': {
      requireState(snapshot, ['submitted']);
      return { state: 'expired' };
    }

    case 'withdraw': {
      requireState(snapshot, ['submitted', 'approved']);
      return { state: 'withdrawn' };
    }
  }
}
