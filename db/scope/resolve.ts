import { eq } from 'drizzle-orm';

import { adminDb } from '@/db/admin';
import { user } from '@/db/schema';

import type { Ulid, UserActor } from './actor';

/**
 * B1's seam: resolve the data-layer actor fields for an already-authenticated
 * user id. This is deliberately a narrow unscoped read, not authentication.
 */
export async function loadActorByUserId(userId: Ulid): Promise<UserActor> {
  const rows = await adminDb()
    .select({
      id: user.id,
      verificationState: user.verificationState,
      standing: user.standing,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('Actor user does not exist');
  return { kind: 'user', ...row };
}
