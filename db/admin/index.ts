import { getAdminDb } from '@/db/client';

/** The single explicitly named BYPASSRLS query surface. */
export function adminDb(): ReturnType<typeof getAdminDb> {
  return getAdminDb();
}
