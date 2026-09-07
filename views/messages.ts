import type { MessageRecord, ThreadRecord } from '@/db/repositories/threads';

/**
 * Thread and message view models (C8). The thread is served only to a confirmed
 * participant (RLS + `policy()`), so `participantCount` is fine to expose to
 * them. `body` IS included on a message — the participant is entitled to the
 * content; agent-rules §3's "never log message bodies" is about logs and audit
 * entries, not about serving the message to the people in the thread.
 *
 * Not exposed: `plan_id` on the thread would let a client cross-reference the
 * plan feed; the thread id plus the `:id` route param the caller already holds
 * are enough. `retention_delete_after` is internal lifecycle.
 */
export interface ThreadView {
  id: string;
  participantCount: number;
}

export function toThreadView(thread: ThreadRecord): ThreadView {
  return { id: thread.id, participantCount: thread.participantCount };
}

export interface MessageView {
  id: string;
  threadId: string;
  senderUserId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export function toMessageView(message: MessageRecord): MessageView {
  return {
    id: message.id,
    threadId: message.threadId,
    senderUserId: message.senderUserId,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt === null ? null : message.editedAt.toISOString(),
  };
}
