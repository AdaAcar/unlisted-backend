import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSessionActor, plans, postMessage, recordAuditEntry, threads } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { auditMeta } from '@/lib/requestMeta';
import { policy } from '@/policy';
import { toMessageView, toThreadView } from '@/views';

import { forbidden, notFound } from '../../context';

/**
 * `GET /plans/:id/thread` (docs/api.md Messages; docs/modes.md): the thread
 * opens ON VIABILITY. Gate is `viable_at` + confirmed participant, not "after
 * invitation" (A5 decision; `modes.md` overrides `api.md` here).
 *
 * A thread the actor may not see returns 404 with no distinction between "no
 * thread", "plan not viable" and "not a participant" — migration 0012's RLS
 * collapses all three (agent-rules §3).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const actor = await getSessionActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const plan = await plans.get(actor, id);
  if (!plan) return notFound();

  const thread = await threads.getByPlan(actor, id);
  if (!thread) return notFound();

  if (
    policy(actor, 'message.getThread', {
      threadParticipant: true,
      viable: plan.viableAt !== null,
    }) !== 'allow'
  ) {
    return notFound();
  }

  const messages = await threads.listMessages(actor, thread.id);
  return NextResponse.json(
    { thread: toThreadView(thread), messages: messages.map(toMessageView) },
    { status: 200 },
  );
}

/**
 * `POST /plans/:id/thread` (docs/api.md Messages): post a message. Same gate as
 * GET. Rate limited per `api.md` — D5, not built here (Redis not installed).
 * The audit entry records that a message was posted, never its body
 * (agent-rules §3).
 */
const postBody = z.object({
  body: z.string().trim().min(1).max(4000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const parsed = postBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const actor = await getSessionActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const plan = await plans.get(actor, id);
  if (!plan) return notFound();

  const thread = await threads.getByPlan(actor, id);
  if (!thread) return notFound();

  if (
    policy(actor, 'message.postThread', {
      threadParticipant: true,
      viable: plan.viableAt !== null,
    }) !== 'allow'
  ) {
    return forbidden();
  }

  const { ipHash, userAgentHash } = auditMeta(request);
  const outcome = await withActor(actor, async (executor) => {
    const result = await postMessage(executor, actor, thread.id, parsed.data.body);
    if (result.ok) {
      await recordAuditEntry(executor, actor, {
        action: 'message_post',
        actorRole: 'user',
        resourceId: thread.id,
        resourceType: 'message_thread',
        afterState: { messageId: result.id },
        ipHash,
        userAgentHash,
      });
    }
    return result;
  });

  if (!outcome.ok) {
    return outcome.reason === 'no_thread'
      ? notFound()
      : NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  return NextResponse.json(
    toMessageView({
      id: outcome.id,
      threadId: thread.id,
      senderUserId: actor.id,
      body: parsed.data.body,
      createdAt: outcome.createdAt,
      editedAt: null,
    }),
    { status: 201 },
  );
}
