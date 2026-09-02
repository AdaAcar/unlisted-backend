import { describe, it, expect } from 'vitest';

import { config } from '@/lib/config';

describe('lib/config', () => {
  it('exposes exactly the section 5 product parameters', () => {
    expect(config).toEqual({
      MIN_HOST_CIRCLE: 1,
      MIN_APPLICANT_CIRCLE: 1,
      MIN_PLAN_TOTAL: 3,
      SPONTANEOUS_THRESHOLD_H: 24,
      RESPONSE_DEADLINE_MAX_H: 12,
      RESPONSE_DEADLINE_MIN_M: 15,
      RESPONSE_DEADLINE_RATIO: 0.25,
    });
  });

  it('pins MIN_PLAN_TOTAL to the structural floor of 3', () => {
    expect(config.MIN_PLAN_TOTAL).toBe(3);
  });

  it('ignores the environment entirely', () => {
    const original = config.MIN_PLAN_TOTAL;
    process.env.MIN_PLAN_TOTAL = '2';
    process.env.SPONTANEOUS_THRESHOLD_H = '999';
    try {
      expect(config.MIN_PLAN_TOTAL).toBe(original);
      expect(config.SPONTANEOUS_THRESHOLD_H).toBe(24);
    } finally {
      delete process.env.MIN_PLAN_TOTAL;
      delete process.env.SPONTANEOUS_THRESHOLD_H;
    }
  });
});
