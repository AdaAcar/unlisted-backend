import { sql, type SQL } from 'drizzle-orm';
import { ulid } from 'ulidx';

import type { Actor, SystemActor, Ulid, UserActor } from '@/db/scope/actor';
import type { ActorTransaction } from '@/db/scope/scoped';

/**
 * Append-only audit write path (todo_agent.md A4; docs/data-model.md "Audit
 * log"). Takes the caller's already-open `withActor`/system executor as a
 * parameter and never opens a transaction of its own — a rolled-back caller
 * transaction leaves no audit row by construction, not by discipline.
 *
 * `actor_id` is derived from `actor`, never accepted as a field: there is no
 * way to call this with someone else's id. The one thing the type system
 * cannot see is whether `actor` actually matches the transaction's GUC
 * (set by `withActor`); migration 0006's `audit_log_app_append` RLS policy is
 * the backstop for that.
 */

interface AuditEntryBase {
  /** Machine-readable action name, e.g. "update_profile". */
  action: string;
  /** State after the action. Omit (rather than pass null) when not applicable. */
  afterState?: unknown;
  /** State before the action. Omit (rather than pass null) when not applicable. */
  beforeState?: unknown;
  /** From `lib/hash.ts`. Never a raw IP — no raw IP reaches this module. */
  ipHash?: string;
  resourceId: Ulid;
  resourceType: string;
  /** From `lib/hash.ts`. Never a raw user agent. */
  userAgentHash?: string;
}

export type UserAuditEntry =
  | (AuditEntryBase & { actorRole: 'circle_lead' | 'user' })
  | (AuditEntryBase & { actorRole: 'moderator'; reason: string });

export type SystemAuditEntry = AuditEntryBase & { actorRole: 'system' };

export type AuditEntry = SystemAuditEntry | UserAuditEntry;

function reasonOf(entry: AuditEntry): string | null {
  return entry.actorRole === 'moderator' ? entry.reason : null;
}

function jsonbParam(value: unknown): SQL {
  return value === undefined ? sql`NULL` : sql`${JSON.stringify(value)}::jsonb`;
}

export function recordAuditEntry(
  executor: ActorTransaction,
  actor: SystemActor,
  entry: SystemAuditEntry,
): Promise<Ulid>;
export function recordAuditEntry(
  executor: ActorTransaction,
  actor: UserActor,
  entry: UserAuditEntry,
): Promise<Ulid>;
export async function recordAuditEntry(
  executor: ActorTransaction,
  actor: Actor,
  entry: AuditEntry,
): Promise<Ulid> {
  const id = ulid();
  const actorId = actor.kind === 'user' ? actor.id : null;

  // No SELECT grant on audit_log for unlisted_app (0006_audit_append.sql), so
  // this cannot use `.returning()` / `RETURNING id` — the id is generated
  // here and handed back directly.
  await executor.execute(sql`
    INSERT INTO audit_log (
      id, actor_id, actor_role, action, resource_type, resource_id,
      before_state, after_state, reason, ip_hash, user_agent_hash
    ) VALUES (
      ${id}, ${actorId}, ${entry.actorRole}, ${entry.action}, ${entry.resourceType}, ${entry.resourceId},
      ${jsonbParam(entry.beforeState)}, ${jsonbParam(entry.afterState)}, ${reasonOf(entry)},
      ${entry.ipHash ?? null}, ${entry.userAgentHash ?? null}
    )
  `);

  return id;
}
