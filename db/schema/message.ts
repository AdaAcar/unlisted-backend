import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { softDelete, timestamps, ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { messageThread } from './messageThread';
import { user } from './user';

/**
 * A message in a thread. `body` is `internal` and must never be logged
 * (CLAUDE.md section 3). Deleted with its thread by the retention worker.
 */
export const message = pgTable(
  'message',
  {
    id: ulidPrimaryKey(),
    threadId: ulidColumn('thread_id')
      .notNull()
      .references(() => messageThread.id, { onDelete: 'cascade' }),
    senderUserId: ulidColumn('sender_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    ulidFormatCheck('message_id_ulid_chk', t.id),
    index('message_thread_created_idx').on(t.threadId, t.createdAt),
  ],
);
