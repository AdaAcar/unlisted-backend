import { sql } from 'drizzle-orm';

import type { Actor } from '@/db/scope/actor';
import { withActor } from '@/db/scope/scoped';

/**
 * Thread and message reads (C8).
 *
 * Like `db/repositories/venues.ts`, these do not go through `scopedSelect` —
 * there is no counterparty-user `VisibilitySpec` to compose. Access is decided
 * entirely by migration 0012's RLS: `message_thread_app_read` requires the
 * plan to be visible AND the actor to be a confirmed participant
 * (`app_thread_participant`), and `message_app_read` additionally drops a
 * blocked co-participant's messages via `app_user_visible(sender_user_id)`.
 * So `getThreadByPlan` returning `undefined` means, indistinguishably: no
 * thread, or the plan is not viable, or the actor is not a participant — all of
 * which the route turns into a single 404.
 *
 * `withActor` is still required to activate `unlisted_app` and the actor GUC
 * the 0012 policies read. This file is in `TRUSTED_DATABASE_FILES` for the raw
 * `executor.execute`.
 */

export interface ThreadRecord {
  id: string;
  planId: string;
  participantCount: number;
}

export interface MessageRecord {
  id: string;
  threadId: string;
  senderUserId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function getThreadByPlan(
  actor: Actor,
  planId: string,
): Promise<ThreadRecord | undefined> {
  return withActor(actor, async (executor) => {
    const result = await executor.execute(sql`
      SELECT id, plan_id AS "planId", participant_count AS "participantCount"
        FROM message_thread
       WHERE plan_id = ${planId} AND deleted_at IS NULL
       LIMIT 1
    `);
    return (result.rows as unknown as ThreadRecord[])[0];
  });
}

export async function listThreadMessages(actor: Actor, threadId: string): Promise<MessageRecord[]> {
  return withActor(actor, async (executor) => {
    const result = await executor.execute(sql`
      SELECT id,
             thread_id AS "threadId",
             sender_user_id AS "senderUserId",
             body,
             created_at AS "createdAt",
             edited_at AS "editedAt"
        FROM message
       WHERE thread_id = ${threadId} AND deleted_at IS NULL
       ORDER BY created_at, id
    `);
    return (
      result.rows as unknown as Array<
        Omit<MessageRecord, 'createdAt' | 'editedAt'> & {
          createdAt: Date | string;
          editedAt: Date | string | null;
        }
      >
    ).map((row) => ({
      ...row,
      createdAt: toDate(row.createdAt),
      editedAt: row.editedAt === null ? null : toDate(row.editedAt),
    }));
  });
}

export const threads = { getByPlan: getThreadByPlan, listMessages: listThreadMessages };
