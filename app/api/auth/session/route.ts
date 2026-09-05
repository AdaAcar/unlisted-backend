import { isValid as isUlid } from 'ulidx';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  authenticate,
  createSession,
  deleteSessionByTokenHash,
  getSessionContext,
  loadActorByUserId,
  recordAuditEntry,
  SESSION_COOKIE_NAME,
} from '@/db';
import { withActor } from '@/db/scope/scoped';
import { hashIpAddress, hashUserAgent } from '@/lib/hash';
import { generateSessionToken, hashSessionToken, SESSION_TTL_SECONDS } from '@/lib/sessionToken';
import { policy } from '@/policy';

/**
 * `POST /auth/session`, `DELETE /auth/session` (docs/api.md Auth).
 *
 * The credential is a stubbed `{ userId }` — there is no login factor in
 * this codebase, deliberately (docs/state.md Decisions). `auth.session.create`
 * and `auth.session.delete` are unconditional-allow / isUser-only rules with
 * no interesting deny path (A5); the route still calls `policy()` so
 * authorization is never inlined here, per agent-rules section 3.
 */

const createSessionBody = z.object({
  userId: z.string().refine(isUlid, 'must be a valid ulid'),
});

const GENERIC_AUTH_FAILURE = { error: 'invalid_credentials' } as const;

function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
}

function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = createSessionBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (policy(null, 'auth.session.create', {}) !== 'allow') {
    return NextResponse.json(GENERIC_AUTH_FAILURE, { status: 401 });
  }

  const userId = await authenticate({ userId: parsed.data.userId });
  if (!userId) {
    return NextResponse.json(GENERIC_AUTH_FAILURE, { status: 401 });
  }

  const actor = await loadActorByUserId(userId);
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = sessionExpiry();
  const ipHash = hashIpAddress(clientIp(request));
  const userAgentHash = hashUserAgent(request.headers.get('user-agent') ?? 'unknown');

  await withActor(actor, async (executor) => {
    const sessionId = await createSession(executor, actor, tokenHash, expiresAt);
    await recordAuditEntry(executor, actor, {
      action: 'session_create',
      actorRole: 'user',
      resourceId: sessionId,
      resourceType: 'session',
      ipHash,
      userAgentHash,
    });
  });

  const response = new NextResponse(null, { status: 204 });
  setSessionCookie(response, token);
  return response;
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const context = await getSessionContext(request);

  if (!context || policy(context.actor, 'auth.session.delete', {}) !== 'allow') {
    // No session (or nothing to authorize) is not an error: revoking a
    // session that is not there is idempotently a no-op, same status either
    // way — this endpoint never signals whether a session existed.
    const response = new NextResponse(null, { status: 204 });
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  }

  const { actor, sessionId, tokenHash } = context;
  const ipHash = hashIpAddress(clientIp(request));
  const userAgentHash = hashUserAgent(request.headers.get('user-agent') ?? 'unknown');

  await withActor(actor, async (executor) => {
    const deleted = await deleteSessionByTokenHash(executor, actor, tokenHash);
    if (!deleted) return;
    await recordAuditEntry(executor, actor, {
      action: 'session_delete',
      actorRole: 'user',
      resourceId: sessionId,
      resourceType: 'session',
      ipHash,
      userAgentHash,
    });
  });

  const response = new NextResponse(null, { status: 204 });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
