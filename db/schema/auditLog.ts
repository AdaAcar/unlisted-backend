import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

import { ULID_PATTERN, ulidColumn, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { auditActorRoleEnum } from './enums';
import { user } from './user';

/**
 * Append-only. Every state-changing action by any actor, and every moderator
 * action without exception. Moderator actions must carry a reason.
 *
 * `resource_id` is polymorphic (any entity), so it is a ULID-shaped column with
 * a format check rather than a foreign key. `actor_id` is null for system and
 * worker actions.
 *
 * Append-only is enforced in 0001_guards.sql by a trigger that rejects UPDATE
 * and DELETE. A GRANT/REVOKE for the application role is deferred to A3 (no such
 * role exists yet) — see docs/state.md section 11. The write-path helper the domain
 * layer calls is A4.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: ulidPrimaryKey(),
    actorId: ulidColumn('actor_id').references(() => user.id, { onDelete: 'restrict' }),
    actorRole: auditActorRoleEnum('actor_role').notNull(),
    action: varchar('action', { length: 100 }).notNull(),
    resourceType: varchar('resource_type', { length: 60 }).notNull(),
    resourceId: ulidColumn('resource_id').notNull(),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    reason: text('reason'),
    ipHash: varchar('ip_hash', { length: 64 }),
    userAgentHash: varchar('user_agent_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    ulidFormatCheck('audit_log_id_ulid_chk', t.id),
    check('audit_log_resource_id_ulid_chk', sql`${t.resourceId} ~ ${sql.raw(`'${ULID_PATTERN}'`)}`),
    check(
      'audit_log_moderator_reason_chk',
      sql`${t.actorRole} <> 'moderator' OR ${t.reason} IS NOT NULL`,
    ),
    index('audit_log_resource_idx').on(t.resourceType, t.resourceId),
    index('audit_log_actor_idx').on(t.actorId, t.createdAt),
  ],
);
