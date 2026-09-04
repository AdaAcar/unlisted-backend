/**
 * Authorization: the single policy module.
 *
 * `policy(actor, action, resource) -> allow | deny`, deny by default. The
 * rule table (`./rules`) is data, not a chain of conditionals, so it can be
 * tested exhaustively and read as a spec. An ownership check is never
 * inlined in a route handler -- callers pass the facts (role, membership,
 * mode, ownership) they already computed, and this module only decides.
 *
 * Populated in task A5. See docs/state.md Decisions and Known gaps (A5).
 */
import { rules } from './rules';

import type { Action, Decision, PolicyActor, ResourceByAction } from './actions';

export type {
  Action,
  CircleMemberStatus,
  CircleRole,
  Decision,
  PlanMode,
  PolicyActor,
  ResourceByAction,
  Ulid,
} from './actions';
export {
  ACTION_ENDPOINTS,
  ASSEMBLY_ENDPOINTS,
  MODE_ONLY_ENDPOINTS,
  MODE_SCOPED_ACTIONS,
} from './actions';

type RuleFn = (actor: PolicyActor, resource: unknown) => boolean;

/**
 * Runtime lookup view of `rules`. `rules` is exhaustive over `Action` by
 * TypeScript construction -- an omitted entry fails to compile. This cast
 * exists only so `policy()` can look up an `action` that arrived through a
 * boundary that bypassed the type system (a malformed request, or the
 * deliberately-mistyped call the completeness test uses) and fall through to
 * `deny` instead of throwing.
 */
const lookup: Partial<Record<string, RuleFn>> = rules as unknown as Partial<Record<string, RuleFn>>;

export function policy<A extends Action>(
  actor: PolicyActor,
  action: A,
  resource: ResourceByAction[A],
): Decision {
  const rule = lookup[action];
  if (rule === undefined) return 'deny';
  return rule(actor, resource) ? 'allow' : 'deny';
}
