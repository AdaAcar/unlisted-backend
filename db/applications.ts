import { sql } from 'drizzle-orm';
import { ulid } from 'ulidx';

import type { Ulid } from '@/db/scope/actor';
import type { ActorTransaction } from '@/db/scope/scoped';
import { computeApplicationVersionHash } from '@/domain/application-version';
import {
  transitionPlannedApplication,
  type PlannedApplicationSnapshot,
  type PlannedApplicationState,
} from '@/domain/application-planned';
import {
  transitionTonightApplication,
  type TonightApplicationState,
} from '@/domain/application-tonight';
import { DomainError } from '@/domain/types';

/**
 * Application write path (C5 / C6, non-capacity actions). Takes the caller's
 * open `withActor` executor and never opens its own transaction — mirroring
 * `db/plans.ts` / `db/circles.ts` — so each write and the route's audit entry
 * commit or roll back together.
 *
 * Every state decision goes through the A6 reducers
 * (`domain/application-planned.ts` / `domain/application-tonight.ts`); nothing
 * here re-derives a transition. The one piece of write-layer logic A6 does not
 * own is the version hash (`domain/application-version.ts`, C5) — the reducers
 * compare a caller-supplied hash but never produce one.
 *
 * The capacity-affecting actions (invite / accept / decline / expiry) live in
 * `db/invitations.ts` because they lock the plan and move its counters. In
 * `TRUSTED_DATABASE_FILES` for the raw `executor.execute`.
 */

interface MemberRow {
  userId: string;
  confirmationState: 'unconfirmed' | 'confirmed';
}

async function loadMembers(executor: ActorTransaction, applicationId: Ulid): Promise<MemberRow[]> {
  const rows = (
    await executor.execute(sql`
      SELECT user_id AS "userId", confirmation_state AS "confirmationState"
        FROM application_member
       WHERE application_id = ${applicationId}
       ORDER BY user_id
    `)
  ).rows as unknown as MemberRow[];
  return rows;
}

/** Enough of an application row to drive the planned/tonight reducers. */
export interface LockedApplication {
  id: Ulid;
  planId: Ulid;
  applicantCircleId: Ulid | null;
  soloUserId: Ulid | null;
  mode: 'planned' | 'tonight';
  state: PlannedApplicationState | TonightApplicationState;
  note: string | null;
}

interface RawLockedApplication {
  id: string;
  plan_id: string;
  applicant_circle_id: string | null;
  solo_user_id: string | null;
  mode: 'planned' | 'tonight';
  state: LockedApplication['state'];
  note: string | null;
}

/** `SELECT ... FOR UPDATE` on an application the actor can see. */
export async function lockApplication(
  executor: ActorTransaction,
  id: Ulid,
): Promise<LockedApplication | undefined> {
  const row = (
    await executor.execute(sql`
      SELECT id, plan_id, applicant_circle_id, solo_user_id, mode, state, note
        FROM application
       WHERE id = ${id}
       FOR UPDATE
    `)
  ).rows[0] as RawLockedApplication | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    planId: row.plan_id,
    applicantCircleId: row.applicant_circle_id,
    soloUserId: row.solo_user_id,
    mode: row.mode,
    state: row.state,
    note: row.note,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateApplicationInput {
  planId: Ulid;
  /** The plan's mode, denormalised onto the application (immutable after create). */
  mode: 'planned' | 'tonight';
  /** Set for a planned circle application; null for solo / tonight. */
  applicantCircleId: Ulid | null;
  /** Set for a solo application (planned or tonight). */
  soloUserId: Ulid | null;
  note: string | null;
  /** Included member user ids for a planned circle application. Ignored otherwise. */
  memberUserIds: readonly Ulid[];
  /** `plan.min_group_size` — enforced for a circle application. */
  minGroupSize: number;
}

export type CreateApplicationOutcome =
  | { ok: true; id: Ulid }
  | { ok: false; reason: 'too_small' | 'already_applied' };

/**
 * `POST /plans/:id/applications`.
 *
 * - planned circle: `awaiting_confirmation`, one `unconfirmed` member row per
 *   included member. Blocked below `min_group_size`.
 * - planned solo: straight to `submitted` (nobody to confirm).
 * - tonight (always solo in effect, docs/modes.md): straight to `submitted`,
 *   no member rows. A group lead binds only themselves; other members call the
 *   endpoint individually.
 */
export async function createApplication(
  executor: ActorTransaction,
  input: CreateApplicationInput,
): Promise<CreateApplicationOutcome> {
  const isCircle = input.applicantCircleId !== null;
  if (isCircle && input.memberUserIds.length < input.minGroupSize) {
    return { ok: false, reason: 'too_small' };
  }

  // One live application per applicant per plan. Terminal states
  // (withdrawn/rejected/declined/expired) do not block re-applying.
  const dupe = (
    await executor.execute(sql`
      SELECT 1 FROM application
       WHERE plan_id = ${input.planId}
         AND state NOT IN ('withdrawn', 'rejected', 'declined', 'expired')
         AND (
           (${input.soloUserId}::varchar IS NOT NULL AND solo_user_id = ${input.soloUserId})
           OR (${input.applicantCircleId}::varchar IS NOT NULL AND applicant_circle_id = ${input.applicantCircleId})
         )
       LIMIT 1
    `)
  ).rows[0];
  if (dupe) return { ok: false, reason: 'already_applied' };

  const id = ulid();
  const state = isCircle ? 'awaiting_confirmation' : 'submitted';
  const submittedAt = isCircle ? null : sql`now()`;
  await executor.execute(sql`
    INSERT INTO application (
      id, plan_id, applicant_circle_id, solo_user_id, mode, state, note, submitted_at
    ) VALUES (
      ${id}, ${input.planId}, ${input.applicantCircleId}, ${input.soloUserId},
      ${input.mode}, ${state}, ${input.note}, ${submittedAt}
    )
  `);

  if (isCircle) {
    const unique = [...new Set(input.memberUserIds)];
    for (const userId of unique) {
      await executor.execute(sql`
        INSERT INTO application_member (id, application_id, user_id)
        VALUES (${ulid()}, ${id}, ${userId})
      `);
    }
  }
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// Confirm (planned circle only)
// ---------------------------------------------------------------------------

export type ConfirmOutcome =
  | { ok: true; submitted: boolean }
  | { ok: false; reason: 'stale' | 'not_member' | 'not_confirmable' };

/**
 * `POST /applications/:id/confirm`. The member confirms a specific version
 * hash; the server checks it is the current one, marks that member's row
 * confirmed, and — if every included member is now confirmed — auto-advances
 * the application to `submitted` (there is no separate submit endpoint; that is
 * how "submission is blocked while any member is unconfirmed" is enforced).
 */
export async function confirmMember(
  executor: ActorTransaction,
  application: LockedApplication,
  actorId: Ulid,
  submittedVersionHash: string,
  now: Date,
): Promise<ConfirmOutcome> {
  if (application.mode !== 'planned' || application.applicantCircleId === null) {
    return { ok: false, reason: 'not_confirmable' };
  }
  if (application.state !== 'awaiting_confirmation' && application.state !== 'submitted') {
    return { ok: false, reason: 'not_confirmable' };
  }

  const membersBefore = await loadMembers(executor, application.id);
  const currentHash = computeApplicationVersionHash({
    note: application.note,
    memberIds: membersBefore.map((m) => m.userId),
  });
  if (submittedVersionHash !== currentHash) return { ok: false, reason: 'stale' };

  const updated = await executor.execute(sql`
    UPDATE application_member
       SET confirmation_state = 'confirmed', confirmed_version_hash = ${currentHash}
     WHERE application_id = ${application.id} AND user_id = ${actorId}
  `);
  if (updated.rowCount === 0) return { ok: false, reason: 'not_member' };

  const allConfirmed = membersBefore.every(
    (m) => m.userId === actorId || m.confirmationState === 'confirmed',
  );
  if (!allConfirmed || application.state === 'submitted') {
    return { ok: true, submitted: application.state === 'submitted' };
  }

  const snapshot: PlannedApplicationSnapshot = {
    state: 'awaiting_confirmation',
    isSolo: false,
    allMembersConfirmed: true,
    responseDeadline: null,
  };
  const next = transitionPlannedApplication(snapshot, { type: 'submit', now });
  await executor.execute(sql`
    UPDATE application SET state = ${next.state}, submitted_at = ${now} WHERE id = ${application.id}
  `);
  return { ok: true, submitted: true };
}

// ---------------------------------------------------------------------------
// Withdraw (whole application) — DELETE /applications/:id
// ---------------------------------------------------------------------------

export type WithdrawOutcome = 'withdrawn' | 'not_withdrawable';

const PRE_INVITATION_PLANNED: readonly PlannedApplicationState[] = [
  'draft',
  'awaiting_confirmation',
  'submitted',
  'shortlisted',
];

export async function withdrawApplication(
  executor: ActorTransaction,
  application: LockedApplication,
  now: Date,
): Promise<WithdrawOutcome> {
  try {
    if (application.mode === 'planned') {
      if (!PRE_INVITATION_PLANNED.includes(application.state as PlannedApplicationState)) {
        return 'not_withdrawable';
      }
      transitionPlannedApplication(
        {
          state: application.state as PlannedApplicationState,
          isSolo: application.soloUserId !== null,
          allMembersConfirmed: false,
          responseDeadline: null,
        },
        { type: 'withdraw', now },
      );
    } else {
      transitionTonightApplication(
        { state: application.state as TonightApplicationState },
        { type: 'withdraw', now },
      );
    }
  } catch (error) {
    if (error instanceof DomainError) return 'not_withdrawable';
    throw error;
  }
  await executor.execute(sql`
    UPDATE application SET state = 'withdrawn', withdrawn_at = ${now} WHERE id = ${application.id}
  `);
  return 'withdrawn';
}

// ---------------------------------------------------------------------------
// Withdraw a member — POST /applications/:id/withdraw-member
// ---------------------------------------------------------------------------

export type WithdrawMemberOutcome =
  | { ok: true; outcome: 'reconfirm' | 'invalidated' }
  | { ok: false; reason: 'not_member' | 'not_allowed' };

/**
 * The member removes their own row. If the remaining set falls below
 * `min_group_size` the whole application is invalidated (withdrawn); otherwise
 * the member-set change voids every remaining confirmation and the `edit`
 * transition drops the application back to `awaiting_confirmation` (A6 C5
 * amendment) — the smaller group must re-confirm and the host re-shortlist.
 */
export async function withdrawMember(
  executor: ActorTransaction,
  application: LockedApplication,
  actorId: Ulid,
  minGroupSize: number,
  now: Date,
): Promise<WithdrawMemberOutcome> {
  if (application.mode !== 'planned' || application.applicantCircleId === null) {
    return { ok: false, reason: 'not_allowed' };
  }
  if (!PRE_INVITATION_PLANNED.includes(application.state as PlannedApplicationState)) {
    return { ok: false, reason: 'not_allowed' };
  }

  const deleted = await executor.execute(sql`
    DELETE FROM application_member WHERE application_id = ${application.id} AND user_id = ${actorId}
  `);
  if (deleted.rowCount === 0) return { ok: false, reason: 'not_member' };

  const remaining = await loadMembers(executor, application.id);

  if (remaining.length < minGroupSize) {
    transitionPlannedApplication(
      {
        state: application.state as PlannedApplicationState,
        isSolo: false,
        allMembersConfirmed: false,
        responseDeadline: null,
      },
      { type: 'withdraw', now },
    );
    await executor.execute(sql`
      UPDATE application SET state = 'withdrawn', withdrawn_at = ${now} WHERE id = ${application.id}
    `);
    return { ok: true, outcome: 'invalidated' };
  }

  await executor.execute(sql`
    UPDATE application_member
       SET confirmation_state = 'unconfirmed', confirmed_version_hash = NULL
     WHERE application_id = ${application.id}
  `);
  const next = transitionPlannedApplication(
    {
      state: application.state as PlannedApplicationState,
      isSolo: false,
      allMembersConfirmed: false,
      responseDeadline: null,
    },
    { type: 'edit', now },
  );
  await executor.execute(sql`
    UPDATE application SET state = ${next.state}, submitted_at = NULL WHERE id = ${application.id}
  `);
  return { ok: true, outcome: 'reconfirm' };
}

// ---------------------------------------------------------------------------
// Review (host lead) — shortlist / unshortlist / reject
// ---------------------------------------------------------------------------

export type ReviewOutcome = 'ok' | 'not_applicable';

async function applyReviewTransition(
  executor: ActorTransaction,
  application: LockedApplication,
  action: 'shortlist' | 'unshortlist' | 'reject',
  now: Date,
): Promise<ReviewOutcome> {
  if (application.mode !== 'planned') return 'not_applicable';
  let next;
  try {
    next = transitionPlannedApplication(
      {
        state: application.state as PlannedApplicationState,
        isSolo: application.soloUserId !== null,
        allMembersConfirmed: false,
        responseDeadline: null,
      },
      { type: action, now },
    );
  } catch (error) {
    if (error instanceof DomainError) return 'not_applicable';
    throw error;
  }
  const decidedAt = action === 'reject' ? now : null;
  await executor.execute(sql`
    UPDATE application
       SET state = ${next.state}, decided_at = ${decidedAt}
     WHERE id = ${application.id}
  `);
  return 'ok';
}

export const shortlistApplication = (e: ActorTransaction, a: LockedApplication, now: Date) =>
  applyReviewTransition(e, a, 'shortlist', now);
export const unshortlistApplication = (e: ActorTransaction, a: LockedApplication, now: Date) =>
  applyReviewTransition(e, a, 'unshortlist', now);
export const rejectApplication = (e: ActorTransaction, a: LockedApplication, now: Date) =>
  applyReviewTransition(e, a, 'reject', now);
