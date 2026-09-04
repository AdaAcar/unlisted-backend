import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const VALID_SECRET = 'a'.repeat(32);

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('audit hashing', () => {
  it('never returns the raw input', async () => {
    process.env.AUDIT_HASH_SECRET = VALID_SECRET;
    const { hashIpAddress } = await import('@/lib/hash');
    const ip = '203.0.113.42';
    expect(hashIpAddress(ip)).not.toContain(ip);
  });

  it('produces a stable 64-character hex digest for an IP address', async () => {
    process.env.AUDIT_HASH_SECRET = VALID_SECRET;
    const { hashIpAddress } = await import('@/lib/hash');
    const first = hashIpAddress('203.0.113.42');
    const second = hashIpAddress('203.0.113.42');
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a stable 64-character hex digest for a user agent', async () => {
    process.env.AUDIT_HASH_SECRET = VALID_SECRET;
    const { hashUserAgent } = await import('@/lib/hash');
    const ua = 'Mozilla/5.0 (test)';
    const first = hashUserAgent(ua);
    const second = hashUserAgent(ua);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different digests for different inputs', async () => {
    process.env.AUDIT_HASH_SECRET = VALID_SECRET;
    const { hashIpAddress } = await import('@/lib/hash');
    expect(hashIpAddress('203.0.113.42')).not.toBe(hashIpAddress('203.0.113.43'));
  });

  it('produces different digests for the same value under different secrets', async () => {
    process.env.AUDIT_HASH_SECRET = VALID_SECRET;
    const { hashIpAddress: hashWithFirstSecret } = await import('@/lib/hash');
    const first = hashWithFirstSecret('203.0.113.42');

    vi.resetModules();
    process.env.AUDIT_HASH_SECRET = 'b'.repeat(32);
    const { hashIpAddress: hashWithSecondSecret } = await import('@/lib/hash');
    const second = hashWithSecondSecret('203.0.113.42');

    expect(first).not.toBe(second);
  });

  it('throws rather than hashing when the secret is missing', async () => {
    delete process.env.AUDIT_HASH_SECRET;
    const { hashIpAddress } = await import('@/lib/hash');
    expect(() => hashIpAddress('203.0.113.42')).toThrow(/AUDIT_HASH_SECRET/);
  });

  it('throws rather than hashing when the secret is too short', async () => {
    process.env.AUDIT_HASH_SECRET = 'short';
    const { hashIpAddress } = await import('@/lib/hash');
    expect(() => hashIpAddress('203.0.113.42')).toThrow(/AUDIT_HASH_SECRET/);
  });
});
