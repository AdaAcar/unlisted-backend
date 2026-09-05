import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const VALID_SECRET = 'a'.repeat(32);

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('identity hashing', () => {
  it('never returns the raw input', async () => {
    process.env.IDENTITY_HASH_SECRET = VALID_SECRET;
    const { hashIdentity } = await import('@/lib/identityHash');
    const reference = 'TR-12345678901';
    expect(hashIdentity(reference)).not.toContain(reference);
  });

  it('produces a stable 64-character hex digest', async () => {
    process.env.IDENTITY_HASH_SECRET = VALID_SECRET;
    const { hashIdentity } = await import('@/lib/identityHash');
    const first = hashIdentity('TR-12345678901');
    const second = hashIdentity('TR-12345678901');
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different digests for different identities', async () => {
    process.env.IDENTITY_HASH_SECRET = VALID_SECRET;
    const { hashIdentity } = await import('@/lib/identityHash');
    expect(hashIdentity('TR-12345678901')).not.toBe(hashIdentity('TR-12345678902'));
  });

  it('produces different digests for the same identity under a different secret', async () => {
    process.env.IDENTITY_HASH_SECRET = VALID_SECRET;
    const { hashIdentity: hashWithFirstSecret } = await import('@/lib/identityHash');
    const first = hashWithFirstSecret('TR-12345678901');

    vi.resetModules();
    process.env.IDENTITY_HASH_SECRET = 'b'.repeat(32);
    const { hashIdentity: hashWithSecondSecret } = await import('@/lib/identityHash');
    const second = hashWithSecondSecret('TR-12345678901');

    expect(first).not.toBe(second);
  });

  it('is a different key than the audit hash secret, even when both are set', async () => {
    process.env.IDENTITY_HASH_SECRET = VALID_SECRET;
    process.env.AUDIT_HASH_SECRET = 'b'.repeat(32);
    const { hashIdentity } = await import('@/lib/identityHash');
    const { hashIpAddress } = await import('@/lib/hash');
    expect(hashIdentity('same-value')).not.toBe(hashIpAddress('same-value'));
  });

  it('throws rather than hashing when the secret is missing', async () => {
    delete process.env.IDENTITY_HASH_SECRET;
    const { hashIdentity } = await import('@/lib/identityHash');
    expect(() => hashIdentity('TR-12345678901')).toThrow(/IDENTITY_HASH_SECRET/);
  });

  it('throws rather than hashing when the secret is too short', async () => {
    process.env.IDENTITY_HASH_SECRET = 'short';
    const { hashIdentity } = await import('@/lib/identityHash');
    expect(() => hashIdentity('TR-12345678901')).toThrow(/IDENTITY_HASH_SECRET/);
  });
});
