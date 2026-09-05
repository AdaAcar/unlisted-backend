import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VerificationOutcome, VerificationVendor } from '@/lib/verificationVendor';

const ORIGINAL_ENV = { ...process.env };
const VALID_SECRET = 'a'.repeat(32);

function headers(value: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => value[name.toLowerCase()] ?? null };
}

function sign(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('stub verification vendor', () => {
  it('starts a session with an opaque, non-empty vendor session ref', async () => {
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    const first = await stubVerificationVendor.startSession('user-1');
    const second = await stubVerificationVendor.startSession('user-1');
    expect(first.vendorSessionRef).toMatch(/^[\w-]+$/);
    expect(first.vendorSessionRef).not.toBe(second.vendorSessionRef);
  });

  it('accepts a correctly signed body', async () => {
    process.env.VERIFICATION_WEBHOOK_SECRET = VALID_SECRET;
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    const body = JSON.stringify({ vendorSessionRef: 'ref', verificationState: 'failed' });
    const signature = sign(VALID_SECRET, body);
    expect(
      stubVerificationVendor.verifyWebhookSignature(
        body,
        headers({ 'x-verification-signature': signature }),
      ),
    ).toBe(true);
  });

  it('rejects a missing signature header', async () => {
    process.env.VERIFICATION_WEBHOOK_SECRET = VALID_SECRET;
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    const body = JSON.stringify({ vendorSessionRef: 'ref', verificationState: 'failed' });
    expect(stubVerificationVendor.verifyWebhookSignature(body, headers({}))).toBe(false);
  });

  it('rejects a wrong signature identically to a missing one (both false, no throw)', async () => {
    process.env.VERIFICATION_WEBHOOK_SECRET = VALID_SECRET;
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    const body = JSON.stringify({ vendorSessionRef: 'ref', verificationState: 'failed' });
    expect(
      stubVerificationVendor.verifyWebhookSignature(
        body,
        headers({ 'x-verification-signature': 'f'.repeat(64) }),
      ),
    ).toBe(false);
  });

  it('rejects a signature computed over a different body (tamper detection)', async () => {
    process.env.VERIFICATION_WEBHOOK_SECRET = VALID_SECRET;
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    const signedBody = JSON.stringify({ vendorSessionRef: 'ref', verificationState: 'failed' });
    const signature = sign(VALID_SECRET, signedBody);
    const tamperedBody = JSON.stringify({ vendorSessionRef: 'ref', verificationState: 'verified' });
    expect(
      stubVerificationVendor.verifyWebhookSignature(
        tamperedBody,
        headers({ 'x-verification-signature': signature }),
      ),
    ).toBe(false);
  });

  it('parses a valid verified payload', async () => {
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    const outcome = stubVerificationVendor.parseWebhookPayload(
      JSON.stringify({
        vendorSessionRef: 'ref',
        verificationState: 'verified',
        age: 25,
        identityReference: 'vendor-identity-1',
      }),
    );
    expect(outcome).toEqual({
      vendorSessionRef: 'ref',
      verificationState: 'verified',
      age: 25,
      identityReference: 'vendor-identity-1',
    });
  });

  it('parses a valid failed payload with no age or identity reference', async () => {
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    const outcome = stubVerificationVendor.parseWebhookPayload(
      JSON.stringify({ vendorSessionRef: 'ref', verificationState: 'failed' }),
    );
    expect(outcome.verificationState).toBe('failed');
    expect(outcome.age).toBeUndefined();
    expect(outcome.identityReference).toBeUndefined();
  });

  it('rejects a verified payload missing age or identityReference', async () => {
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    expect(() =>
      stubVerificationVendor.parseWebhookPayload(
        JSON.stringify({ vendorSessionRef: 'ref', verificationState: 'verified' }),
      ),
    ).toThrow();
  });

  it('rejects malformed JSON', async () => {
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    expect(() => stubVerificationVendor.parseWebhookPayload('not json')).toThrow();
  });

  it('never accepts an underage assertion', async () => {
    const { stubVerificationVendor } = await import('@/lib/verificationVendor');
    expect(() =>
      stubVerificationVendor.parseWebhookPayload(
        JSON.stringify({
          vendorSessionRef: 'ref',
          verificationState: 'verified',
          age: 12,
          identityReference: 'vendor-identity-1',
        }),
      ),
    ).toThrow();
  });
});

describe('getVerificationVendor', () => {
  it('selects the stub by default', async () => {
    delete process.env.VERIFICATION_VENDOR;
    const { getVerificationVendor, stubVerificationVendor } = await import(
      '@/lib/verificationVendor'
    );
    expect(getVerificationVendor()).toBe(stubVerificationVendor);
  });

  it('throws for an unrecognized vendor rather than silently falling back to the stub', async () => {
    process.env.VERIFICATION_VENDOR = 'realvendor';
    const { getVerificationVendor } = await import('@/lib/verificationVendor');
    expect(() => getVerificationVendor()).toThrow(/VERIFICATION_VENDOR/);
  });
});

describe('VerificationVendor interface', () => {
  it('is satisfied by an implementation that is not the stub, proving callers depend only on the interface', async () => {
    // A hand-rolled implementation that shares nothing with the stub's
    // internals (no HMAC, no particular ref format) -- if this type-checks
    // and behaves like any other VerificationVendor, nothing route-level
    // needs to change when a real vendor replaces the stub.
    const fakeVendor: VerificationVendor = {
      async startSession() {
        return { vendorSessionRef: 'fake-vendor-ref' };
      },
      verifyWebhookSignature: (_rawBody, headers) => headers.get('x-fake-signature') === 'ok',
      parseWebhookPayload: (rawBody) => JSON.parse(rawBody) as VerificationOutcome,
    };

    const session = await fakeVendor.startSession('some-user-id');
    expect(session.vendorSessionRef).toBe('fake-vendor-ref');

    const rawBody = JSON.stringify({
      vendorSessionRef: session.vendorSessionRef,
      verificationState: 'verified',
      age: 40,
      identityReference: 'fake-vendor-identity',
    });
    expect(
      fakeVendor.verifyWebhookSignature(rawBody, {
        get: (name) => (name === 'x-fake-signature' ? 'ok' : null),
      }),
    ).toBe(true);
    expect(fakeVendor.parseWebhookPayload(rawBody)).toEqual({
      vendorSessionRef: 'fake-vendor-ref',
      verificationState: 'verified',
      age: 40,
      identityReference: 'fake-vendor-identity',
    });
  });
});
