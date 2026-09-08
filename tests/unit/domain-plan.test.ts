import { describe, expect, it } from 'vitest';

import { config } from '@/lib/config';
import { DomainError, type PlanMode } from '@/domain/types';
import {
  canPublish,
  computeMode,
  computeViableAt,
  confirmedTotal,
  isViable,
  transitionPlan,
  type PlanAction,
  type PlanSnapshot,
  type PlanState,
} from '@/domain/plan';

const HOUR = 1000 * 60 * 60;
const STARTS_AT = new Date('2026-09-10T20:00:00Z');
const NOW = new Date('2026-09-05T12:00:00Z'); // 5+ days before STARTS_AT

function snapshot(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    state: 'draft',
    mode: null,
    startsAt: STARTS_AT,
    openSpots: 5,
    confirmedHostCount: 1,
    acceptedGuestCount: 0,
    heldCount: 0,
    viableAt: null,
    applicationsClosedAt: null,
    cancellationKind: null,
    ...overrides,
  };
}

const STATES: readonly PlanState[] = [
  'draft',
  'published',
  'applications_closed',
  'completed',
  'cancelled',
];

/** (state, mode) fixtures. `draft` has no mode yet -- it is set at publish. */
const FIXTURES: readonly [PlanState, PlanMode | null][] = STATES.flatMap(
  (state): [PlanState, PlanMode | null][] =>
    state === 'draft'
      ? [[state, null]]
      : (['planned', 'tonight'] as const).map((mode) => [state, mode]),
);

describe('canPublish / computeMode / isViable', () => {
  it('feasibility is host size + open spots >= MIN_PLAN_TOTAL', () => {
    expect(canPublish(1, config.MIN_PLAN_TOTAL - 1 - 1)).toBe(false);
    expect(canPublish(1, config.MIN_PLAN_TOTAL - 1)).toBe(true);
    expect(canPublish(0, config.MIN_PLAN_TOTAL)).toBe(true);
  });

  it('mode is planned at exactly the threshold and tonight just below it', () => {
    const atThreshold = new Date(NOW.getTime() + config.SPONTANEOUS_THRESHOLD_H * HOUR);
    const belowThreshold = new Date(atThreshold.getTime() - 1);
    expect(computeMode(atThreshold, NOW)).toBe('planned');
    expect(computeMode(belowThreshold, NOW)).toBe('tonight');
  });

  it('viability is the floor AND at least one accepted guest (Decision B)', () => {
    // Below the floor, regardless of guests.
    expect(isViable({ confirmedHostCount: 1, acceptedGuestCount: 1 })).toBe(false);
    // At the floor but a host circle meeting itself (0 guests) -> not viable.
    expect(isViable({ confirmedHostCount: config.MIN_PLAN_TOTAL, acceptedGuestCount: 0 })).toBe(
      false,
    );
    expect(isViable({ confirmedHostCount: config.MIN_PLAN_TOTAL + 5, acceptedGuestCount: 0 })).toBe(
      false,
    );
    // At the floor with one accepted guest -> viable.
    expect(isViable({ confirmedHostCount: config.MIN_PLAN_TOTAL - 1, acceptedGuestCount: 1 })).toBe(
      true,
    );
    expect(isViable({ confirmedHostCount: 0, acceptedGuestCount: config.MIN_PLAN_TOTAL })).toBe(
      true,
    );
  });

  it('confirmedTotal sums host and guest counts', () => {
    expect(confirmedTotal({ confirmedHostCount: 2, acceptedGuestCount: 3 })).toBe(5);
  });
});

const belowFloor = { confirmedHostCount: 1, acceptedGuestCount: 1 };
const hostOnlyAtFloor = { confirmedHostCount: config.MIN_PLAN_TOTAL, acceptedGuestCount: 0 };
const atFloorWithGuest = {
  confirmedHostCount: config.MIN_PLAN_TOTAL - 1,
  acceptedGuestCount: 1,
};

describe('viable_at latch', () => {
  it('stays null below the floor', () => {
    expect(computeViableAt(null, belowFloor, NOW)).toBeNull();
  });

  it('stays null for a host circle alone at the floor (Decision B: needs a guest)', () => {
    expect(computeViableAt(null, hostOnlyAtFloor, NOW)).toBeNull();
  });

  it('latches to now on first crossing (floor reached with an accepted guest)', () => {
    expect(computeViableAt(null, atFloorWithGuest, NOW)).toEqual(NOW);
  });

  it('never clears once set, even if the counts later drop below the floor', () => {
    const latchedAt = new Date(NOW.getTime() - HOUR);
    const later = new Date(NOW.getTime() + HOUR);
    expect(
      computeViableAt(latchedAt, { confirmedHostCount: 0, acceptedGuestCount: 0 }, later),
    ).toEqual(latchedAt);
    expect(computeViableAt(latchedAt, hostOnlyAtFloor, later)).toEqual(latchedAt);
  });
});

describe('publish', () => {
  it.each(STATES)('is only valid from draft (tried from %s)', (state) => {
    const base = snapshot({ state, mode: state === 'draft' ? null : 'planned' });
    const action: PlanAction = { type: 'publish', hostSize: 2, now: NOW };
    if (state === 'draft') {
      const next = transitionPlan(base, action);
      expect(next.state).toBe('published');
    } else {
      expect(() => transitionPlan(base, action)).toThrow(DomainError);
    }
  });

  it('rejects an infeasible plan', () => {
    const base = snapshot({ state: 'draft', openSpots: 0 });
    expect(() => transitionPlan(base, { type: 'publish', hostSize: 1, now: NOW })).toThrow(
      DomainError,
    );
  });

  it('rejects publishing after starts_at has passed', () => {
    const base = snapshot({ state: 'draft' });
    expect(() => transitionPlan(base, { type: 'publish', hostSize: 2, now: STARTS_AT })).toThrow(
      DomainError,
    );
  });

  it('computes and stores mode from the horizon at publish time', () => {
    const soon = snapshot({
      state: 'draft',
      startsAt: new Date(NOW.getTime() + 2 * HOUR),
    });
    const next = transitionPlan(soon, { type: 'publish', hostSize: 2, now: NOW });
    expect(next.mode).toBe('tonight');

    const far = snapshot({
      state: 'draft',
      startsAt: new Date(NOW.getTime() + 48 * HOUR),
    });
    const nextFar = transitionPlan(far, { type: 'publish', hostSize: 2, now: NOW });
    expect(nextFar.mode).toBe('planned');
  });

  it('mode is immutable after publish: a second publish attempt is rejected', () => {
    const draft = snapshot({ state: 'draft' });
    const published = transitionPlan(draft, { type: 'publish', hostSize: 2, now: NOW });
    expect(() => transitionPlan(published, { type: 'publish', hostSize: 2, now: NOW })).toThrow(
      DomainError,
    );
    // No action in the machine ever writes `mode` again -- structurally
    // immutable, not merely guarded.
    expect(published.mode).not.toBeNull();
  });
});

/** Every other action, exhaustively over every (state, mode) pair. */
const GENERIC_ACTIONS = [
  'invite',
  'declineInvitation',
  'expireInvitation',
  'acceptInvitation',
  'approve',
  'withdrawGuest',
  'setHostCount',
  'cancel',
] as const;

function buildGenericAction(type: (typeof GENERIC_ACTIONS)[number], now: Date): PlanAction {
  switch (type) {
    case 'invite':
      return { type, count: 1, now };
    case 'declineInvitation':
    case 'expireInvitation':
    case 'acceptInvitation':
    case 'withdrawGuest':
      // count 0 is a safe no-op amount: it cannot trip a capacity or
      // non-negativity guard, so it isolates the state/mode guard.
      return { type, count: 0, now };
    case 'approve':
      return { type, count: 1, now };
    case 'setHostCount':
      return { type, confirmedHostCount: 1, now };
    case 'cancel':
      return { type, now };
  }
}

function isReachable(
  state: PlanState,
  mode: PlanMode | null,
  type: (typeof GENERIC_ACTIONS)[number],
): boolean {
  const active = state === 'published' || state === 'applications_closed';
  switch (type) {
    case 'invite':
      // New invitations only go out while applications are open.
      return state === 'published' && mode === 'planned';
    case 'declineInvitation':
    case 'expireInvitation':
    case 'acceptInvitation':
      // Already-issued holds may still resolve after applications close.
      return active && mode === 'planned';
    case 'approve':
      return active && mode === 'tonight';
    case 'withdrawGuest':
    case 'setHostCount':
      return active;
    case 'cancel':
      return state === 'draft' || active;
  }
}

describe('exhaustive state x mode x action', () => {
  const cases = FIXTURES.flatMap(([state, mode]) =>
    GENERIC_ACTIONS.map((type) => ({ state, mode, type })),
  );

  it.each(cases)('$type from $state/$mode', ({ state, mode, type }) => {
    const base = snapshot({ state, mode });
    const action = buildGenericAction(type, NOW);
    if (isReachable(state, mode, type)) {
      expect(() => transitionPlan(base, action)).not.toThrow();
    } else {
      expect(() => transitionPlan(base, action)).toThrow(DomainError);
    }
  });
});

describe('planned-only invitation soft hold', () => {
  it('invite places a hold that counts toward the capacity ceiling', () => {
    const base = snapshot({ state: 'published', mode: 'planned', openSpots: 2 });
    const next = transitionPlan(base, { type: 'invite', count: 2, now: NOW });
    expect(next.heldCount).toBe(2);
    expect(next.acceptedGuestCount).toBe(0);
  });

  it('rejects an invite that would push accepted + held over open spots', () => {
    const base = snapshot({
      state: 'published',
      mode: 'planned',
      openSpots: 2,
      acceptedGuestCount: 1,
      heldCount: 1,
    });
    expect(() => transitionPlan(base, { type: 'invite', count: 1, now: NOW })).toThrow(DomainError);
  });

  it('decline releases the hold', () => {
    const base = snapshot({ state: 'published', mode: 'planned', heldCount: 2 });
    const next = transitionPlan(base, {
      type: 'declineInvitation',
      count: 1,
      now: NOW,
    });
    expect(next.heldCount).toBe(1);
  });

  it('expiry releases the hold', () => {
    const base = snapshot({ state: 'published', mode: 'planned', heldCount: 2 });
    const next = transitionPlan(base, { type: 'expireInvitation', count: 1, now: NOW });
    expect(next.heldCount).toBe(1);
  });

  it('rejects releasing more hold than exists', () => {
    const base = snapshot({ state: 'published', mode: 'planned', heldCount: 1 });
    expect(() => transitionPlan(base, { type: 'declineInvitation', count: 2, now: NOW })).toThrow(
      DomainError,
    );
  });

  it('accepting an invitation converts a held spot to an accepted one, capacity unchanged', () => {
    const base = snapshot({
      state: 'published',
      mode: 'planned',
      openSpots: 2,
      heldCount: 1,
    });
    const next = transitionPlan(base, { type: 'acceptInvitation', count: 1, now: NOW });
    expect(next.heldCount).toBe(0);
    expect(next.acceptedGuestCount).toBe(1);
  });

  it('acceptInvitation cannot convert more than is held', () => {
    const base = snapshot({ state: 'published', mode: 'planned', heldCount: 1 });
    expect(() => transitionPlan(base, { type: 'acceptInvitation', count: 2, now: NOW })).toThrow(
      DomainError,
    );
  });

  it('a two-applicant over-invitation cannot both be accepted into the same spot', () => {
    // Regression for the exact failure mode described in the review: without
    // the held-count ceiling, inviting two applicants for one spot would let
    // both accept.
    let base = snapshot({ state: 'published', mode: 'planned', openSpots: 1 });
    base = transitionPlan(base, { type: 'invite', count: 1, now: NOW });
    expect(() => transitionPlan(base, { type: 'invite', count: 1, now: NOW })).toThrow(DomainError);
  });
});

describe('tonight-only direct approve', () => {
  it('approve hard-consumes a spot directly, with no hold', () => {
    const base = snapshot({ state: 'published', mode: 'tonight', openSpots: 1 });
    const next = transitionPlan(base, { type: 'approve', count: 1, now: NOW });
    expect(next.acceptedGuestCount).toBe(1);
    expect(next.heldCount).toBe(0);
  });

  it('rejects approval over capacity', () => {
    const base = snapshot({
      state: 'published',
      mode: 'tonight',
      openSpots: 1,
      acceptedGuestCount: 1,
    });
    expect(() => transitionPlan(base, { type: 'approve', count: 1, now: NOW })).toThrow(
      DomainError,
    );
  });

  it('invite/decline/expire/acceptInvitation are unreachable in tonight mode', () => {
    const base = snapshot({ state: 'published', mode: 'tonight' });
    for (const type of [
      'invite',
      'declineInvitation',
      'expireInvitation',
      'acceptInvitation',
    ] as const) {
      expect(() => transitionPlan(base, buildGenericAction(type, NOW))).toThrow(DomainError);
    }
  });
});

describe('withdrawGuest and setHostCount', () => {
  it('withdrawGuest cannot go negative', () => {
    const base = snapshot({ state: 'published', acceptedGuestCount: 1 });
    expect(() => transitionPlan(base, { type: 'withdrawGuest', count: 2, now: NOW })).toThrow(
      DomainError,
    );
  });

  it('setHostCount rejects a negative count', () => {
    const base = snapshot({ state: 'published' });
    expect(() =>
      transitionPlan(base, { type: 'setHostCount', confirmedHostCount: -1, now: NOW }),
    ).toThrow(DomainError);
  });

  it('withdrawGuest and setHostCount work in both modes', () => {
    for (const mode of ['planned', 'tonight'] as const) {
      const base = snapshot({ state: 'published', mode, acceptedGuestCount: 1 });
      expect(() =>
        transitionPlan(base, { type: 'withdrawGuest', count: 1, now: NOW }),
      ).not.toThrow();
      expect(() =>
        transitionPlan(base, { type: 'setHostCount', confirmedHostCount: 2, now: NOW }),
      ).not.toThrow();
    }
  });
});

describe('close: the three closure conditions', () => {
  it.each(STATES)('capacity_filled is only valid from published (tried from %s)', (state) => {
    const base = snapshot({ state, mode: state === 'draft' ? null : 'planned' });
    const action: PlanAction = { type: 'close', trigger: 'capacity_filled', now: NOW };
    if (state === 'published') {
      const next = transitionPlan(base, action);
      expect(next.state).toBe('applications_closed');
      expect(next.applicationsClosedAt).toEqual(NOW);
    } else {
      expect(() => transitionPlan(base, action)).toThrow(DomainError);
    }
  });

  it.each(STATES)('host_closed is only valid from published (tried from %s)', (state) => {
    const base = snapshot({ state, mode: state === 'draft' ? null : 'planned' });
    const action: PlanAction = { type: 'close', trigger: 'host_closed', now: NOW };
    if (state === 'published') {
      const next = transitionPlan(base, action);
      expect(next.state).toBe('applications_closed');
    } else {
      expect(() => transitionPlan(base, action)).toThrow(DomainError);
    }
  });

  it('starts_at always stamps applications_closed_at, from published or applications_closed', () => {
    for (const state of ['published', 'applications_closed'] as const) {
      const base = snapshot({
        state,
        mode: 'planned',
        confirmedHostCount: config.MIN_PLAN_TOTAL - 1,
        acceptedGuestCount: 1,
      });
      const next = transitionPlan(base, { type: 'close', trigger: 'starts_at', now: NOW });
      expect(next.applicationsClosedAt).toEqual(NOW);
    }
  });

  it('starts_at does not overwrite an already-set applications_closed_at', () => {
    const earlier = new Date(NOW.getTime() - HOUR);
    const base = snapshot({
      state: 'applications_closed',
      mode: 'planned',
      applicationsClosedAt: earlier,
      confirmedHostCount: config.MIN_PLAN_TOTAL - 1,
      acceptedGuestCount: 1,
    });
    const next = transitionPlan(base, { type: 'close', trigger: 'starts_at', now: NOW });
    expect(next.applicationsClosedAt).toEqual(earlier);
  });

  it('starts_at closure skips applications_closed when the plan is viable: state is unchanged', () => {
    const base = snapshot({
      state: 'published',
      mode: 'planned',
      confirmedHostCount: config.MIN_PLAN_TOTAL - 1,
      acceptedGuestCount: 1,
    });
    const next = transitionPlan(base, { type: 'close', trigger: 'starts_at', now: NOW });
    expect(next.state).toBe('published');
  });

  it('starts_at closure auto-cancels a host-only plan at the floor (Decision B: 0 guests is not viable)', () => {
    const base = snapshot({
      state: 'published',
      mode: 'tonight',
      confirmedHostCount: config.MIN_PLAN_TOTAL,
      acceptedGuestCount: 0,
    });
    const next = transitionPlan(base, { type: 'close', trigger: 'starts_at', now: NOW });
    expect(next.state).toBe('cancelled');
    expect(next.cancellationKind).toBe('non_viable');
  });

  it('starts_at closure auto-cancels a non-viable plan, from either published or applications_closed', () => {
    for (const state of ['published', 'applications_closed'] as const) {
      const base = snapshot({ state, mode: 'planned', confirmedHostCount: 1 });
      const next = transitionPlan(base, { type: 'close', trigger: 'starts_at', now: NOW });
      expect(next.state).toBe('cancelled');
      expect(next.cancellationKind).toBe('non_viable');
    }
  });

  it.each(STATES)(
    'starts_at is only valid from published or applications_closed (tried from %s)',
    (state) => {
      if (state === 'published' || state === 'applications_closed') return;
      const base = snapshot({ state, mode: state === 'draft' ? null : 'planned' });
      expect(() => transitionPlan(base, { type: 'close', trigger: 'starts_at', now: NOW })).toThrow(
        DomainError,
      );
    },
  );
});

describe('cancel', () => {
  it('host cancel is valid before completion, from any active or draft state', () => {
    for (const state of ['draft', 'published', 'applications_closed'] as const) {
      const base = snapshot({ state, mode: state === 'draft' ? null : 'planned' });
      const next = transitionPlan(base, { type: 'cancel', now: NOW });
      expect(next.state).toBe('cancelled');
      expect(next.cancellationKind).toBe('host');
    }
  });

  it('cannot cancel a completed or already-cancelled plan', () => {
    for (const state of ['completed', 'cancelled'] as const) {
      const base = snapshot({ state, mode: 'planned' });
      expect(() => transitionPlan(base, { type: 'cancel', now: NOW })).toThrow(DomainError);
    }
  });
});

describe('complete', () => {
  it('requires starts_at to have passed', () => {
    const base = snapshot({
      state: 'published',
      mode: 'planned',
      confirmedHostCount: config.MIN_PLAN_TOTAL - 1,
      acceptedGuestCount: 1,
    });
    expect(() => transitionPlan(base, { type: 'complete', now: NOW })).toThrow(DomainError);
    const next = transitionPlan(base, { type: 'complete', now: STARTS_AT });
    expect(next.state).toBe('completed');
  });

  it('cannot complete a non-viable plan', () => {
    const base = snapshot({ state: 'published', mode: 'planned', confirmedHostCount: 1 });
    expect(() => transitionPlan(base, { type: 'complete', now: STARTS_AT })).toThrow(DomainError);
  });

  it('cannot complete a host-only plan at the floor (Decision B: needs an accepted guest)', () => {
    const base = snapshot({
      state: 'published',
      mode: 'tonight',
      confirmedHostCount: config.MIN_PLAN_TOTAL,
      acceptedGuestCount: 0,
    });
    expect(() => transitionPlan(base, { type: 'complete', now: STARTS_AT })).toThrow(DomainError);
  });

  it.each(['draft', 'completed', 'cancelled'] as const)('is unreachable from %s', (state) => {
    const base = snapshot({
      state,
      mode: state === 'draft' ? null : 'planned',
      confirmedHostCount: config.MIN_PLAN_TOTAL - 1,
      acceptedGuestCount: 1,
    });
    expect(() => transitionPlan(base, { type: 'complete', now: STARTS_AT })).toThrow(DomainError);
  });
});

describe('the invariant: no sequence produces a viable plan under MIN_PLAN_TOTAL', () => {
  it('a dyad (host lead + one guest) is never latched viable, through accept, then invite+accept', () => {
    let plan = snapshot({ state: 'draft', openSpots: 2, confirmedHostCount: 1 });
    plan = transitionPlan(plan, { type: 'publish', hostSize: 1, now: NOW });

    // Sequence 1: a single guest accepts via the full invite -> accept path.
    let seq1 = transitionPlan(plan, { type: 'invite', count: 1, now: NOW });
    seq1 = transitionPlan(seq1, { type: 'acceptInvitation', count: 1, now: NOW });
    expect(confirmedTotal(seq1)).toBe(2);
    expect(seq1.viableAt).toBeNull();

    // Sequence 2: same, but the second spot's invitation is later declined --
    // still never crosses the floor.
    let seq2 = transitionPlan(plan, { type: 'invite', count: 2, now: NOW });
    seq2 = transitionPlan(seq2, { type: 'acceptInvitation', count: 1, now: NOW });
    seq2 = transitionPlan(seq2, { type: 'declineInvitation', count: 1, now: NOW });
    expect(confirmedTotal(seq2)).toBe(2);
    expect(seq2.viableAt).toBeNull();
  });

  it('crossing exactly to MIN_PLAN_TOTAL latches; staying at MIN_PLAN_TOTAL - 1 never does, across every ordering', () => {
    let plan = snapshot({ state: 'draft', openSpots: 2, confirmedHostCount: 1 });
    plan = transitionPlan(plan, { type: 'publish', hostSize: 1, now: NOW });
    plan = transitionPlan(plan, { type: 'invite', count: 2, now: NOW });

    const onlyOneAccepts = transitionPlan(plan, { type: 'acceptInvitation', count: 1, now: NOW });
    expect(onlyOneAccepts.viableAt).toBeNull();

    const bothAccept = transitionPlan(onlyOneAccepts, {
      type: 'acceptInvitation',
      count: 1,
      now: NOW,
    });
    expect(confirmedTotal(bothAccept)).toBe(config.MIN_PLAN_TOTAL);
    expect(bothAccept.viableAt).toEqual(NOW);
  });

  it('a latched-then-dropped plan keeps viable_at set but still auto-cancels at starts_at', () => {
    let plan = snapshot({ state: 'draft', openSpots: 2, confirmedHostCount: 1 });
    plan = transitionPlan(plan, { type: 'publish', hostSize: 1, now: NOW });
    plan = transitionPlan(plan, { type: 'invite', count: 2, now: NOW });
    plan = transitionPlan(plan, { type: 'acceptInvitation', count: 2, now: NOW });
    expect(plan.viableAt).toEqual(NOW);
    expect(confirmedTotal(plan)).toBe(3);

    // One guest withdraws, dropping below the floor. The latch does not clear.
    const later = new Date(NOW.getTime() + HOUR);
    plan = transitionPlan(plan, { type: 'withdrawGuest', count: 1, now: later });
    expect(plan.viableAt).toEqual(NOW);
    expect(confirmedTotal(plan)).toBe(2);

    // At starts_at the plan is re-evaluated live and auto-cancels, even though
    // viable_at is still set.
    const atStart = transitionPlan(plan, {
      type: 'close',
      trigger: 'starts_at',
      now: STARTS_AT,
    });
    expect(atStart.viableAt).toEqual(NOW);
    expect(atStart.state).toBe('cancelled');
    expect(atStart.cancellationKind).toBe('non_viable');

    // And it can never be completed from here.
    expect(() => transitionPlan(atStart, { type: 'complete', now: STARTS_AT })).toThrow(
      DomainError,
    );
  });

  it('a recovered plan (freed spot re-filled before starts_at) can still reach completion', () => {
    let plan = snapshot({ state: 'draft', openSpots: 2, confirmedHostCount: 1 });
    plan = transitionPlan(plan, { type: 'publish', hostSize: 1, now: NOW });
    plan = transitionPlan(plan, { type: 'invite', count: 2, now: NOW });
    plan = transitionPlan(plan, { type: 'acceptInvitation', count: 2, now: NOW });
    plan = transitionPlan(plan, { type: 'withdrawGuest', count: 1, now: NOW });
    expect(confirmedTotal(plan)).toBe(2);

    // The freed spot is re-filled before starts_at.
    plan = transitionPlan(plan, { type: 'invite', count: 1, now: NOW });
    plan = transitionPlan(plan, { type: 'acceptInvitation', count: 1, now: NOW });
    expect(confirmedTotal(plan)).toBe(3);

    const completed = transitionPlan(plan, { type: 'complete', now: STARTS_AT });
    expect(completed.state).toBe('completed');
  });
});
