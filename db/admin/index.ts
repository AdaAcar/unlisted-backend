import { sql } from 'drizzle-orm';

import { getAdminDb } from '@/db/client';

type AdminDatabase = ReturnType<typeof getAdminDb>;
export type AdminTransaction = Parameters<Parameters<AdminDatabase['transaction']>[0]>[0];

/** Every cross-actor read assumes the non-bypass capability transaction-locally. */
export async function withAdmin<TResult>(
  fn: (executor: AdminTransaction) => Promise<TResult>,
): Promise<TResult> {
  return getAdminDb().transaction(async (transaction) => {
    await transaction.execute(sql.raw('SET LOCAL ROLE unlisted_admin'));
    return fn(transaction);
  });
}
