import { sql } from 'drizzle-orm';

import type { Actor } from '@/db/scope/actor';
import { withActor } from '@/db/scope/scoped';

/**
 * Application reads (C5 / C6).
 *
 * Like `db/repositories/threads.ts` / `venues.ts`, these run plain `SELECT`s
 * under `withActor` rather than through `scopedSelect` — there is no
 * counterparty-user `VisibilitySpec` for an application. Access is decided by
 * migration 0002's `app_application_visible` (RLS `application_app_read` /
 * `application_member_app_read`): it admits the solo applicant, an applicant
 * member, an active applicant-circle member, and any active host-circle member.
 * So `getApplication` returning `undefined` means, indistinguishably: no such
 * application, or the actor may not see it — a single 404 at the route.
 *
 * The route still calls `policy()` for the real authorization (host writes are
 * lead-only; `GET /applications/:id` is applicant-member-or-host-lead).
 *
 * In `TRUSTED_DATABASE_FILES` for the raw `executor.execute`.
 */

export type ApplicationState =
  | 'draft'
  | 'awaiting_confirmation'
  | 'submitted'
  | 'shortlisted'
  | 'invited'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'rejected'
  | 'withdrawn'
  | 'approved';

export interface ApplicationMemberRecord {
  userId: string;
  confirmationState: 'unconfirmed' | 'confirmed';
  confirmedVersionHash: string | null;
  invitationState: 'not_invited' | 'invited' | 'accepted' | 'declined' | 'expired';
  holdExpiresAt: Date | null;
}

export interface ApplicationRecord {
  id: string;
  planId: string;
  applicantCircleId: string | null;
  soloUserId: string | null;
  mode: 'planned' | 'tonight';
  state: ApplicationState;
  note: string | null;
  responseDeadline: Date | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  withdrawnAt: Date | null;
  members: ApplicationMemberRecord[];
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}
function toDateOrNull(v: Date | string | null): Date | null {
  return v === null ? null : toDate(v);
}

interface RawApplication {
  id: string;
  planId: string;
  applicantCircleId: string | null;
  soloUserId: string | null;
  mode: 'planned' | 'tonight';
  state: ApplicationState;
  note: string | null;
  responseDeadline: Date | string | null;
  submittedAt: Date | string | null;
  decidedAt: Date | string | null;
  withdrawnAt: Date | string | null;
}

interface RawMember {
  applicationId: string;
  userId: string;
  confirmationState: 'unconfirmed' | 'confirmed';
  confirmedVersionHash: string | null;
  invitationState: ApplicationMemberRecord['invitationState'];
  holdExpiresAt: Date | string | null;
}

const APPLICATION_COLUMNS = sql`
  id,
  plan_id AS "planId",
  applicant_circle_id AS "applicantCircleId",
  solo_user_id AS "soloUserId",
  mode,
  state,
  note,
  response_deadline AS "responseDeadline",
  submitted_at AS "submittedAt",
  decided_at AS "decidedAt",
  withdrawn_at AS "withdrawnAt"`;

function decodeMember(row: RawMember): ApplicationMemberRecord {
  return {
    userId: row.userId,
    confirmationState: row.confirmationState,
    confirmedVersionHash: row.confirmedVersionHash,
    invitationState: row.invitationState,
    holdExpiresAt: toDateOrNull(row.holdExpiresAt),
  };
}

function decodeApplication(
  row: RawApplication,
  members: ApplicationMemberRecord[],
): ApplicationRecord {
  return {
    id: row.id,
    planId: row.planId,
    applicantCircleId: row.applicantCircleId,
    soloUserId: row.soloUserId,
    mode: row.mode,
    state: row.state,
    note: row.note,
    responseDeadline: toDateOrNull(row.responseDeadline),
    submittedAt: toDateOrNull(row.submittedAt),
    decidedAt: toDateOrNull(row.decidedAt),
    withdrawnAt: toDateOrNull(row.withdrawnAt),
    members,
  };
}

export async function getApplication(
  actor: Actor,
  id: string,
): Promise<ApplicationRecord | undefined> {
  return withActor(actor, async (executor) => {
    const app = (
      await executor.execute(
        sql`SELECT ${APPLICATION_COLUMNS} FROM application WHERE id = ${id} LIMIT 1`,
      )
    ).rows[0] as RawApplication | undefined;
    if (!app) return undefined;
    const members = (
      await executor.execute(sql`
        SELECT application_id AS "applicationId",
               user_id AS "userId",
               confirmation_state AS "confirmationState",
               confirmed_version_hash AS "confirmedVersionHash",
               invitation_state AS "invitationState",
               hold_expires_at AS "holdExpiresAt"
          FROM application_member
         WHERE application_id = ${id}
         ORDER BY user_id
      `)
    ).rows as unknown as RawMember[];
    return decodeApplication(app, members.map(decodeMember));
  });
}

/**
 * `GET /plans/:id/applications` (C6, planned mode) — the host circle lead's
 * review list. Group context is preserved: each row keeps its `members` array,
 * never flattened into individuals. In-progress applications (`draft` /
 * `awaiting_confirmation`) are excluded — the host sees an application only once
 * it has been submitted.
 */
export async function listPlanApplications(
  actor: Actor,
  planId: string,
): Promise<ApplicationRecord[]> {
  return withActor(actor, async (executor) => {
    const apps = (
      await executor.execute(sql`
        SELECT ${APPLICATION_COLUMNS}
          FROM application
         WHERE plan_id = ${planId}
           AND state NOT IN ('draft', 'awaiting_confirmation')
         ORDER BY submitted_at NULLS LAST, id
      `)
    ).rows as unknown as RawApplication[];
    if (apps.length === 0) return [];
    const ids = apps.map((a) => a.id);
    const members = (
      await executor.execute(sql`
        SELECT application_id AS "applicationId",
               user_id AS "userId",
               confirmation_state AS "confirmationState",
               confirmed_version_hash AS "confirmedVersionHash",
               invitation_state AS "invitationState",
               hold_expires_at AS "holdExpiresAt"
          FROM application_member
         WHERE application_id IN (${sql.join(
           ids.map((x) => sql`${x}`),
           sql`, `,
         )})
         ORDER BY application_id, user_id
      `)
    ).rows as unknown as RawMember[];
    const byApp = new Map<string, ApplicationMemberRecord[]>();
    for (const m of members) {
      const list = byApp.get(m.applicationId) ?? [];
      list.push(decodeMember(m));
      byApp.set(m.applicationId, list);
    }
    return apps.map((a) => decodeApplication(a, byApp.get(a.id) ?? []));
  });
}

export const applications = { get: getApplication, listForPlan: listPlanApplications };
