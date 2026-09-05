import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { env } from './env';

/**
 * Vendor-agnostic verification port (B2, todo_agent.md). A real vendor drops
 * in later by implementing this interface — nothing outside this file (the
 * route handlers, `db/verification.ts`) may depend on how a vendor signs a
 * webhook or shapes its payload, only on this interface's normalized shapes.
 */

export interface VerificationStartResult {
  /** Opaque token identifying this vendor session. Not personal data. */
  vendorSessionRef: string;
}

/** The normalized result of a webhook event, after vendor-specific parsing. */
export interface VerificationOutcome {
  vendorSessionRef: string;
  verificationState: 'verified' | 'failed';
  /** Present only when verified. Never a date of birth (agent-rules section 3). */
  age?: number;
  /** The vendor's identity reference. Hashed by the caller; never persisted raw. */
  identityReference?: string;
}

interface HeaderSource {
  get(name: string): string | null;
}

export interface VerificationVendor {
  /** `POST /verification/start`. No document ever touches our servers. */
  startSession(userId: string): Promise<VerificationStartResult>;

  /**
   * Must be checked against the raw, unparsed webhook body before anything
   * else touches it (todo_agent.md B2: "verifies its signature before
   * parsing the body").
   */
  verifyWebhookSignature(rawBody: string, headers: HeaderSource): boolean;

  /** Only ever called after `verifyWebhookSignature` has returned true. */
  parseWebhookPayload(rawBody: string): VerificationOutcome;
}

const SIGNATURE_HEADER = 'x-verification-signature';

function sign(rawBody: string): string {
  return createHmac('sha256', env.verificationWebhookSecret).update(rawBody).digest('hex');
}

const webhookBodySchema = z
  .object({
    vendorSessionRef: z.string().min(1),
    verificationState: z.enum(['verified', 'failed']),
    age: z.number().int().min(18).max(120).optional(),
    identityReference: z.string().min(1).optional(),
  })
  .refine(
    (body) =>
      body.verificationState !== 'verified' ||
      (body.age !== undefined && body.identityReference !== undefined),
    { message: 'a verified outcome requires age and identityReference' },
  );

/**
 * Stub implementation (todo_agent.md B2: "the stub is correct for now", no
 * paid vendor integrated). Signs/verifies with our own HMAC rather than
 * calling out anywhere. Selected by the `env.verificationVendor` flag.
 */
export const stubVerificationVendor: VerificationVendor = {
  async startSession(): Promise<VerificationStartResult> {
    return { vendorSessionRef: randomBytes(24).toString('base64url') };
  },

  verifyWebhookSignature(rawBody, headers): boolean {
    const provided = headers.get(SIGNATURE_HEADER);
    if (!provided || !/^[0-9a-f]{64}$/i.test(provided)) return false;

    const expected = sign(rawBody);
    const providedBuffer = Buffer.from(provided, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return timingSafeEqual(providedBuffer, expectedBuffer);
  },

  parseWebhookPayload(rawBody): VerificationOutcome {
    return webhookBodySchema.parse(JSON.parse(rawBody));
  },
};

/**
 * `env.verificationVendor` already fails closed on anything it doesn't
 * recognize (`lib/env.ts`). This is the seam a real vendor's implementation
 * gets selected from once one exists.
 */
export function getVerificationVendor(): VerificationVendor {
  const vendor = env.verificationVendor;
  if (vendor === 'stub') return stubVerificationVendor;
  throw new Error(`Unrecognized verification vendor: ${String(vendor)}`);
}
