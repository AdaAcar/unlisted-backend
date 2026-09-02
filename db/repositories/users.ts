import { sql, type SQL } from 'drizzle-orm';

import type { Actor } from '@/db/scope/actor';
import { scopedSelect, type ScopedQuery } from '@/db/scope/scoped';
import { visibilitySpecs } from '@/db/scope/visibility';

export interface ProfileRecord {
  id: string;
  firstName: string;
  photos: string[];
  bio: string | null;
  age: number | null;
  district: string | null;
  verificationState: 'none' | 'pending' | 'verified' | 'failed';
  standing: 'good' | 'restricted' | 'suspended' | 'banned';
}

const selection = sql`
  scoped_user.id AS "id",
  scoped_user.first_name AS "firstName",
  scoped_user.photos AS "photos",
  scoped_user.bio AS "bio",
  scoped_user.age AS "age",
  scoped_user.district AS "district",
  scoped_user.verification_state AS "verificationState",
  scoped_user.standing AS "standing"`;

function participant(userId: SQL): SQL {
  return sql`(
    EXISTS (
      SELECT 1 FROM circle_member shared_host_member
      WHERE shared_host_member.circle_id = shared_plan.host_circle_id
        AND shared_host_member.user_id = ${userId}
        AND shared_host_member.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM application shared_application
      WHERE shared_application.plan_id = shared_plan.id
        AND shared_application.state <> 'withdrawn'
        AND (
          shared_application.solo_user_id = ${userId}
          OR EXISTS (
            SELECT 1 FROM application_member shared_application_member
            WHERE shared_application_member.application_id = shared_application.id
              AND shared_application_member.user_id = ${userId}
          )
        )
    )
  )`;
}

function sharedPlanContext(actor: Actor): SQL {
  if (actor.kind !== 'user') return sql`FALSE`;
  return sql`EXISTS (
    SELECT 1 FROM plan shared_plan
    WHERE ${participant(sql`${actor.id}`)}
      AND ${participant(sql`scoped_user.id`)}
  )`;
}

function getProfile(actor: Actor, subjectId: string): ScopedQuery<ProfileRecord | undefined> {
  return scopedSelect<ProfileRecord, ProfileRecord | undefined>({
    actor,
    businessPredicates: [
      sql`scoped_user.id = ${subjectId}`,
      sql`scoped_user.deleted_at IS NULL`,
      sharedPlanContext(actor),
    ],
    decode: (rows) => rows[0],
    selection,
    spec: visibilitySpecs.user,
    tail: sql`LIMIT 1`,
  });
}

export const users = { getProfile };
