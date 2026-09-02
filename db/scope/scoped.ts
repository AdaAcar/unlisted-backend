import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Query } from 'drizzle-orm/sql';

import { getAppDb } from '@/db/client';

import type { Actor } from './actor';
import { applyVisibility, type ScopedSelectDefinition, type VisibilitySpec } from './visibility';

type AppDatabase = ReturnType<typeof getAppDb>;
type ActorTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

export interface ScopedQuery<TResult> extends PromiseLike<TResult> {
  execute: () => Promise<TResult>;
  toSQL: () => Query;
}

function actorScope(actor: Actor): { id: string; standing: string } {
  return actor.kind === 'user'
    ? { id: actor.id, standing: actor.standing }
    : { id: `system:${actor.label}`, standing: 'good' };
}

/** Every actor-scoped query, reads included, runs inside this transaction. */
export async function withActor<TResult>(
  actor: Actor,
  fn: (executor: ActorTransaction) => Promise<TResult>,
): Promise<TResult> {
  const scope = actorScope(actor);
  return getAppDb().transaction(async (transaction) => {
    await transaction.execute(sql`SELECT set_config('app.actor_id', ${scope.id}, true)`);
    await transaction.execute(
      sql`SELECT set_config('app.actor_standing', ${scope.standing}, true)`,
    );
    return fn(transaction);
  });
}

function whereClause(predicates: SQL[]): SQL {
  return sql.join(
    predicates.map((predicate) => sql`(${predicate})`),
    sql` AND `,
  );
}

export interface ScopedSelectOptions<TRow extends object, TResult> {
  actor: Actor;
  businessPredicates?: SQL[];
  decode: (rows: TRow[]) => TResult;
  selection: SQL;
  spec: VisibilitySpec;
  tail?: SQL;
}

/**
 * Builds a lazy, compilable query. Visibility is applied here, before a
 * repository can add business filters, and execution always enters withActor.
 */
export function scopedSelect<TRow extends object, TResult>(
  options: ScopedSelectOptions<TRow, TResult>,
): ScopedQuery<TResult> {
  const initial: ScopedSelectDefinition = {
    predicates: options.businessPredicates ?? [],
  };
  const scoped = applyVisibility(initial, options.actor, options.spec);
  const statement = sql`SELECT ${options.selection} FROM ${options.spec.from}
    WHERE ${whereClause(scoped.predicates)} ${options.tail ?? sql``}`;
  const dialect = new PgDialect();

  const execute = async (): Promise<TResult> =>
    withActor(options.actor, async (executor) => {
      const result = await executor.execute(statement);
      return options.decode(result.rows as unknown as TRow[]);
    });

  return {
    execute,
    toSQL: () => dialect.sqlToQuery(statement),
    then: (onfulfilled, onrejected) => execute().then(onfulfilled, onrejected),
  };
}
