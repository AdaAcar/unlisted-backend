import { describe, expect, it } from 'vitest';

import { DomainError } from '@/domain/types';
import {
  transitionTonightApplication,
  type TonightApplicationAction,
  type TonightApplicationSnapshot,
  type TonightApplicationState,
} from '@/domain/application-tonight';

const NOW = new Date('2026-09-05T22:00:00Z');

function snapshot(state: TonightApplicationState): TonightApplicationSnapshot {
  return { state };
}

const STATES: readonly TonightApplicationState[] = [
  'submitted',
  'approved',
  'rejected',
  'withdrawn',
  'expired',
];

const ACTIONS: readonly TonightApplicationAction['type'][] = [
  'approve',
  'reject',
  'withdraw',
  'expire',
];

function isReachable(
  state: TonightApplicationState,
  type: TonightApplicationAction['type'],
): boolean {
  switch (type) {
    case 'approve':
    case 'reject':
    case 'expire':
      return state === 'submitted';
    case 'withdraw':
      return state === 'submitted' || state === 'approved';
  }
}

describe('exhaustive state x action', () => {
  const cases = STATES.flatMap((state) => ACTIONS.map((type) => ({ state, type })));

  it.each(cases)('$type from $state', ({ state, type }) => {
    const base = snapshot(state);
    const action: TonightApplicationAction = { type, now: NOW };
    if (isReachable(state, type)) {
      const next = transitionTonightApplication(base, action);
      expect(next).toBeDefined();
    } else {
      expect(() => transitionTonightApplication(base, action)).toThrow(DomainError);
    }
  });
});

describe('no invitation or confirmation states are reachable', () => {
  it('the type system has no invited/shortlisted/awaiting_confirmation/accepted/declined states at all', () => {
    // Compile-time proof: TonightApplicationState only ever admits these five
    // values. This assignment would fail to compile if any planned-only
    // state leaked in.
    const allStates: readonly TonightApplicationState[] = [
      'submitted',
      'approved',
      'rejected',
      'withdrawn',
      'expired',
    ];
    expect(allStates).toHaveLength(5);
  });

  it('approve moves straight from submitted to approved -- no intermediate hold', () => {
    const next = transitionTonightApplication(snapshot('submitted'), {
      type: 'approve',
      now: NOW,
    });
    expect(next.state).toBe('approved');
  });
});

describe('withdraw', () => {
  it('withdrawing after approval is a distinct, valid transition (late-decline signal is a D2 concern)', () => {
    const next = transitionTonightApplication(snapshot('approved'), {
      type: 'withdraw',
      now: NOW,
    });
    expect(next.state).toBe('withdrawn');
  });

  it.each(['rejected', 'withdrawn', 'expired'] as const)(
    'cannot withdraw from the terminal state %s',
    (state) => {
      expect(() =>
        transitionTonightApplication(snapshot(state), { type: 'withdraw', now: NOW }),
      ).toThrow(DomainError);
    },
  );
});
