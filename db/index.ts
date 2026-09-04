/**
 * Application data-layer entry point: actor-scoped repositories, plus the
 * append-only audit write helper (A4). `recordAuditEntry` takes the caller's
 * open transaction rather than a fresh connection — see `db/audit.ts` — so it
 * is exported on its own, not wrapped in a repository shape. `withActor`
 * itself is deliberately not re-exported here: the domain layer that will
 * call this (A6+) must not import from `db/` at all (agent-rules section 4),
 * so composing an executor and calling this helper happens at the `app/api`
 * boundary, not inside `domain/`.
 */
export {
  recordAuditEntry,
  type AuditEntry,
  type SystemAuditEntry,
  type UserAuditEntry,
} from './audit';
export { plans, users } from './repositories';
