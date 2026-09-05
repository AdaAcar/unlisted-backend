import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { policy } from '@/policy';

/**
 * `POST /auth/recover` (docs/api.md Auth): "Always returns success regardless
 * of account existence." There is no login factor in this codebase yet
 * (docs/state.md Decisions), so there is nothing to look up and nothing to
 * send — `identifier` stands in for whatever field a real recovery factor
 * will eventually use, validated for shape only and never read past that.
 * No audit entry: this endpoint does not change any state.
 */

const recoverBody = z.object({
  identifier: z.string().min(1),
});

const GENERIC_SUCCESS = { ok: true } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = recoverBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  policy(null, 'auth.recover', {});
  return NextResponse.json(GENERIC_SUCCESS, { status: 200 });
}
