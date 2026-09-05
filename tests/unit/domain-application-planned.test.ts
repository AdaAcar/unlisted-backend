import { describe, expect, it } from 'vitest';

import { config } from '@/lib/config';
import { DomainError } from '@/domain/types';
import {
  computeResponseDeadline,
  transitionPlannedApplication,
  voidStaleConfirmations,
  type MemberConfirmation,
  type PlannedApplicationAction,
  type PlannedApplicationSnapshot,
  type PlannedApplicationState,
} from '@/domain/application-planned';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const STARTS_AT = new Date('2026-09-10T20:00:00Z');
const NOW = new Date('2026-09-08T20:00:00Z'); // 48h before STARTS_AT

function snapshot(overrides: Partial<PlannedApplicationSnapshot> = {}): PlannedApplicationSnapshot {
  return {
    state: 'draft',
    isSolo: false,
    allMembersConfirmed: false,
    responseDeadline: null,
    ...overrides,
  };
}

const STATES: readonly PlannedApplicationState[] = [
  'draft',
  'awaiting_confirmation',
  'submitted',
  'shortlisted',
  'invited',
  'accepted',
  'declined',
  'expired',
  'rejected',
  'withdrawn',
];

describe('response deadline clamp', () => {
  it('clamps to the minimum floor when the ratio would be smaller', () => {
    const now = new Date(STARTS_AT.getTime() - 30 * MIN); // ratio*30min is tiny
    const deadline = computeResponseDeadline(now, STARTS_AT);
    expect(deadline.getTime() - now.getTime()).toBe(config.RESPONSE_DEADLINE_MIN_M * MIN);
  });

  it('clamps to the maximum ceiling when the ratio would be larger', () => {
    const now = new Date(STARTS_AT.getTime() - 100 * HOUR);
    const deadline = computeResponseDeadline(now, STARTS_AT);
    expect(deadline.getTime() - now.getTime()).toBe(config.RESPONSE_DEADLINE_MAX_H * HOUR);
  });

  it('uses the ratio in between the two bounds', () => {
    const remainingH = 20;
    const now = new Date(STARTS_AT.getTime() - remainingH * HOUR);
    const deadline = computeResponseDeadline(now, STARTS_AT);
    const expectedMs = remainingH * HOUR * config.RESPONSE_DEADLINE_RATIO;
    expect(deadline.getTime() - now.getTime()).toBe(expectedMs);
  });

  it('never lands past starts_at, even when the floor would overshoot it', () => {
    const now = new Date(STARTS_AT.getTime() - 5 * MIN); // less than the floor itself
    const deadline = computeResponseDeadline(now, STARTS_AT);
    expect(deadline.getTime()).toBeLessThanOrEqual(STARTS_AT.getTime());
    expect(deadline).toEqual(STARTS_AT);
  });
});

describe('voidStaleConfirmations', () => {
  it('unconfirms any member whose confirmed hash does not match the current version', () => {
    const members: MemberConfirmation[] = [
      { userId: 'A', confirmed: true, confirmedVersionHash: 'v1' },
      { userId: 'B', confirmed: true, confirmedVersionHash: 'v2' },
      { userId: 'C', confirmed: false, confirmedVersionHash: null },
    ];
    const result = voidStaleConfirmations(members, 'v2');
    expect(result).toEqual([
      { userId: 'A', confirmed: false, confirmedVersionHash: null },
      { userId: 'B', confirmed: true, confirmedVersionHash: 'v2' },
      { userId: 'C', confirmed: false, confirmedVersionHash: null },
    ]);
  });

  it('is a pure string compare: it does not compute or validate a hash', () => {
    // Any opaque string works -- voidStaleConfirmations never inspects its shape.
    const members: MemberConfirmation[] = [
      { userId: 'A', confirmed: true, confirmedVersionHash: 'not-a-real-hash-at-all' },
    ];
    expect(voidStaleConfirmations(members, 'not-a-real-hash-at-all')).toEqual(members);
  });
});

describe('exhaustive state x action (solo application, no member confirmation gate)', () => {
  const ACTIONS: readonly PlannedApplicationAction['type'][] = [
    'submit',
    'edit',
    'shortlist',
    'reject',
    'invite',
    'accept',
    'decline',
    'expire',
    'withdraw',
  ];

  function buildAction(
    type: PlannedApplicationAction['type'],
    now: Date,
  ): PlannedApplicationAction {
    switch (type) {
      case 'submit':
        return { type, now };
      case 'edit':
        return { type, now };
      case 'shortlist':
        return { type, now };
      case 'reject':
        return { type, now };
      case 'invite':
        return { type, invitedCount: 1, includedCount: 1, startsAt: STARTS_AT, now };
      case 'accept':
        return { type, now };
      case 'decline':
        return { type, now };
      case 'expire':
        return { type, now };
      case 'withdraw':
        return { type, now };
    }
  }

  function isReachable(
    state: PlannedApplicationState,
    type: PlannedApplicationAction['type'],
  ): boolean {
    switch (type) {
      case 'submit':
        return state === 'draft' || state === 'awaiting_confirmation';
      case 'edit':
        return state === 'draft' || state === 'awaiting_confirmation';
      case 'shortlist':
        return state === 'submitted';
      case 'reject':
        return state === 'submitted' || state === 'shortlisted';
      case 'invite':
        return state === 'shortlisted';
      case 'accept':
      case 'decline':
      case 'expire':
        return state === 'invited';
      case 'withdraw':
        return (
          state === 'draft' ||
          state === 'awaiting_confirmation' ||
          state === 'submitted' ||
          state === 'shortlisted' ||
          state === 'invited' ||
          state === 'accepted'
        );
    }
  }

  const cases = STATES.flatMap((state) => ACTIONS.map((type) => ({ state, type })));

  it.each(cases)('$type from $state', ({ state, type }) => {
    const base = snapshot({ state, isSolo: true, allMembersConfirmed: true });
    const action = buildAction(type, NOW);
    if (isReachable(state, type)) {
      expect(() => transitionPlannedApplication(base, action)).not.toThrow();
    } else {
      expect(() => transitionPlannedApplication(base, action)).toThrow(DomainError);
    }
  });
});

describe('submit is gated on member confirmation for circle applications', () => {
  it('rejects submit while any included member is unconfirmed', () => {
    const base = snapshot({
      state: 'awaiting_confirmation',
      isSolo: false,
      allMembersConfirmed: false,
    });
    expect(() => transitionPlannedApplication(base, { type: 'submit', now: NOW })).toThrow(
      DomainError,
    );
  });

  it('allows submit once every included member has confirmed', () => {
    const base = snapshot({
      state: 'awaiting_confirmation',
      isSolo: false,
      allMembersConfirmed: true,
    });
    const next = transitionPlannedApplication(base, { type: 'submit', now: NOW });
    expect(next.state).toBe('submitted');
  });

  it('a solo application is never gated on confirmation', () => {
    const base = snapshot({ state: 'draft', isSolo: true, allMembersConfirmed: false });
    const next = transitionPlannedApplication(base, { type: 'submit', now: NOW });
    expect(next.state).toBe('submitted');
  });
});

describe('editing after partial confirmation voids prior confirmations', () => {
  it('an edit while awaiting confirmation resets allMembersConfirmed and stays in the same state', () => {
    const base = snapshot({
      state: 'awaiting_confirmation',
      isSolo: false,
      allMembersConfirmed: true, // was fully confirmed before the edit
    });
    const next = transitionPlannedApplication(base, { type: 'edit', now: NOW });
    expect(next.state).toBe('awaiting_confirmation');
    expect(next.allMembersConfirmed).toBe(false);
  });

  it('an edit in draft leaves the application in draft, still unconfirmed', () => {
    const base = snapshot({ state: 'draft', isSolo: false, allMembersConfirmed: false });
    const next = transitionPlannedApplication(base, { type: 'edit', now: NOW });
    expect(next.state).toBe('draft');
    expect(next.allMembersConfirmed).toBe(false);
  });

  it('cannot edit once submitted', () => {
    const base = snapshot({ state: 'submitted' });
    expect(() => transitionPlannedApplication(base, { type: 'edit', now: NOW })).toThrow(
      DomainError,
    );
  });
});

describe('invitation: full vs partial', () => {
  it('a full invite (invited == included) moves to invited and sets a response deadline', () => {
    const base = snapshot({ state: 'shortlisted' });
    const next = transitionPlannedApplication(base, {
      type: 'invite',
      invitedCount: 3,
      includedCount: 3,
      startsAt: STARTS_AT,
      now: NOW,
    });
    expect(next.state).toBe('invited');
    expect(next.responseDeadline).not.toBeNull();
    expect(next.responseDeadline!.getTime()).toBeLessThanOrEqual(STARTS_AT.getTime());
  });

  it('a partial invite (invited < included) returns the circle to awaiting_confirmation, not invited', () => {
    const base = snapshot({ state: 'shortlisted', allMembersConfirmed: true });
    const next = transitionPlannedApplication(base, {
      type: 'invite',
      invitedCount: 2,
      includedCount: 3,
      startsAt: STARTS_AT,
      now: NOW,
    });
    expect(next.state).toBe('awaiting_confirmation');
    // Re-consent is required from the smaller invited group.
    expect(next.allMembersConfirmed).toBe(false);
    expect(next.responseDeadline).toBeNull();
  });

  it('rejects an invite with invitedCount greater than includedCount', () => {
    const base = snapshot({ state: 'shortlisted' });
    expect(() =>
      transitionPlannedApplication(base, {
        type: 'invite',
        invitedCount: 4,
        includedCount: 3,
        startsAt: STARTS_AT,
        now: NOW,
      }),
    ).toThrow(DomainError);
  });

  it('accept, decline, and expire are only reachable from invited', () => {
    for (const type of ['accept', 'decline', 'expire'] as const) {
      const base = snapshot({ state: 'shortlisted' });
      expect(() => transitionPlannedApplication(base, { type, now: NOW })).toThrow(DomainError);
    }
  });
});

describe('withdraw', () => {
  it.each(['declined', 'expired', 'rejected', 'withdrawn'] as const)(
    'cannot withdraw from the terminal state %s',
    (state) => {
      const base = snapshot({ state });
      expect(() => transitionPlannedApplication(base, { type: 'withdraw', now: NOW })).toThrow(
        DomainError,
      );
    },
  );

  it('can withdraw after acceptance', () => {
    const base = snapshot({ state: 'accepted' });
    const next = transitionPlannedApplication(base, { type: 'withdraw', now: NOW });
    expect(next.state).toBe('withdrawn');
  });
});
