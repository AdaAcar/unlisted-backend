import { describe, expect, it } from 'vitest';

import { computeApplicationVersionHash } from '@/domain/application-version';

describe('computeApplicationVersionHash', () => {
  it('is a 64-char hex sha256 digest', () => {
    const hash = computeApplicationVersionHash({ note: 'drinks', memberIds: ['A', 'B'] });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of member id order or duplicates', () => {
    const a = computeApplicationVersionHash({ note: 'x', memberIds: ['01A', '01B', '01C'] });
    const b = computeApplicationVersionHash({ note: 'x', memberIds: ['01C', '01A', '01B', '01A'] });
    expect(a).toBe(b);
  });

  it('changes when the member set changes', () => {
    const a = computeApplicationVersionHash({ note: 'x', memberIds: ['A', 'B'] });
    const b = computeApplicationVersionHash({ note: 'x', memberIds: ['A', 'B', 'C'] });
    expect(a).not.toBe(b);
  });

  it('changes when the note changes', () => {
    const a = computeApplicationVersionHash({ note: 'come at 8', memberIds: ['A'] });
    const b = computeApplicationVersionHash({ note: 'come at 9', memberIds: ['A'] });
    expect(a).not.toBe(b);
  });

  it('treats null and empty-string notes identically, and trims surrounding whitespace', () => {
    const base = computeApplicationVersionHash({ note: 'hi', memberIds: ['A'] });
    expect(computeApplicationVersionHash({ note: null, memberIds: ['A'] })).toBe(
      computeApplicationVersionHash({ note: '   ', memberIds: ['A'] }),
    );
    expect(computeApplicationVersionHash({ note: '  hi  ', memberIds: ['A'] })).toBe(base);
  });

  it('does NOT collapse internal whitespace -- two visibly different notes never collide', () => {
    const a = computeApplicationVersionHash({ note: 'a b', memberIds: ['A'] });
    const b = computeApplicationVersionHash({ note: 'a  b', memberIds: ['A'] });
    expect(a).not.toBe(b);
  });

  it('normalises Unicode to NFC so the same text in two encodings matches', () => {
    const composed = computeApplicationVersionHash({ note: 'café', memberIds: ['A'] });
    const decomposed = computeApplicationVersionHash({ note: 'café', memberIds: ['A'] });
    expect(composed).toBe(decomposed);
  });
});
