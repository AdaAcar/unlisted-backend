import { sql, type SQL } from 'drizzle-orm';

import type { Actor } from './actor';

export interface ScopedSelectDefinition {
  predicates: SQL[];
}

export interface VisibilitySpec {
  from: SQL;
  predicate: (actor: Actor) => SQL;
}

function actorScopeId(actor: Actor): string {
  return actor.kind === 'user' ? actor.id : `system:${actor.label}`;
}

/** Bidirectional block exclusion, authored once for every scoped SQL query. */
export function blockPredicate(actorId: string, counterpartyUserIdExpr: SQL): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM block visibility_block
    WHERE (visibility_block.blocker_user_id = ${actorId}
           AND visibility_block.blocked_user_id = ${counterpartyUserIdExpr})
       OR (visibility_block.blocker_user_id = ${counterpartyUserIdExpr}
           AND visibility_block.blocked_user_id = ${actorId})
  )`;
}

/** Restricted, suspended, and banned users are visible only to themselves. */
export function enforcementPredicate(
  actorId: string,
  counterpartyUserIdExpr: SQL,
  counterpartyStandingExpr: SQL,
): SQL {
  return sql`(${counterpartyStandingExpr} NOT IN ('restricted', 'suspended', 'banned')
              OR ${counterpartyUserIdExpr} = ${actorId})`;
}

function directUserPredicate(actor: Actor, idExpr: SQL, standingExpr: SQL): SQL {
  const actorId = actorScopeId(actor);
  const enforcement = enforcementPredicate(actorId, idExpr, standingExpr);
  return actor.kind === 'system'
    ? enforcement
    : sql`${blockPredicate(actorId, idExpr)} AND ${enforcement}`;
}

export const visibilitySpecs = {
  plan: {
    from: sql`plan scoped_plan`,
    predicate(actor: Actor): SQL {
      const hostMemberVisible = directUserPredicate(
        actor,
        sql`visibility_host.user_id`,
        sql`visibility_host_user.standing`,
      );
      const visibleToOutsider = sql`NOT EXISTS (
        SELECT 1
        FROM circle_member visibility_host
        JOIN "user" visibility_host_user ON visibility_host_user.id = visibility_host.user_id
        WHERE visibility_host.circle_id = scoped_plan.host_circle_id
          AND visibility_host.status = 'active'
          AND NOT (${hostMemberVisible})
      )`;
      return actor.kind === 'user'
        ? sql`(app_actor_hosts_circle(scoped_plan.host_circle_id) OR ${visibleToOutsider})`
        : visibleToOutsider;
    },
  },
  user: {
    from: sql`"user" scoped_user`,
    predicate(actor: Actor): SQL {
      return directUserPredicate(actor, sql`scoped_user.id`, sql`scoped_user.standing`);
    },
  },
} satisfies Record<string, VisibilitySpec>;

/** Compose visibility into a scoped select definition before SQL is executed. */
export function applyVisibility(
  query: ScopedSelectDefinition,
  actor: Actor,
  spec: VisibilitySpec,
): ScopedSelectDefinition {
  return { predicates: [...query.predicates, spec.predicate(actor)] };
}
