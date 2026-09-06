import { NextResponse, type NextRequest } from 'next/server';

import { circles } from '@/db';
import { policy } from '@/policy';
import { toCircleView } from '@/views';

import { circleContext, notFound } from '../context';

/**
 * `GET /circles/:id` (docs/api.md Circles): members only. A non-member —
 * including an invited-but-not-accepted user — gets 404, never 403: the
 * circle's existence is not disclosed to anyone outside it (agent-rules
 * section 3).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const ctx = await circleContext(request, id);
  if (!ctx.ok) return ctx.response;
  const { actor, facts } = ctx;

  if (facts.membershipStatus !== 'active') return notFound();
  if (policy(actor, 'circle.get', { membershipStatus: facts.membershipStatus }) !== 'allow') {
    return notFound();
  }

  const circle = await circles.get(actor, id);
  if (!circle) return notFound();

  return NextResponse.json(toCircleView(circle), { status: 200 });
}
