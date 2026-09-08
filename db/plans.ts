import { sql, type SQL } from 'drizzle-orm';
import { ulid } from 'ulidx';

import type { Ulid } from '@/db/scope/actor';
import type { ActorTransaction } from '@/db/scope/scoped';
import { canPublish, transitionPlan, type PlanSnapshot, type PlanState } from '@/domain/plan';
import { DomainError, type PlanMode } from '@/domain/types';

/**
 * Plan write path (C3). Takes the caller's already-open `withActor` executor
 * and never opens its own transaction — mirroring `db/circles.ts` /
 * `db/session.ts` / `db/audit.ts` — so each plan write and the audit entry the
 * route records alongside it commit or roll back together.
 *
 * This is the first real caller of the A6 plan reducer. Every state decision
 * goes through `domain/plan.ts`'s `transitionPlan`; nothing here re-derives
 * feasibility, the `viable_at` latch, closure, or mode. The four row-level
 * guards in `0001_guards.sql` (mode immutability, viable_at latch, viable_at
 * set-time floor) and the generated `confirmed_total` column are the database
 * backstop underneath these calls, not logic to duplicate.
 *
 * No authorization lives here: the route calls `policy()` first and migration
 * 0011's `plan_app_insert` / `plan_app_update` RLS (gated on C1's
 * `app_actor_leads_circle`) is a backstop on every statement. A non-lead's
 * `SELECT ... FOR UPDATE` matches zero rows, which every operation reports as
 * a typed outcome the route maps to a status code.
 */

/** Enough of a locked plan row to drive the reducer and the "editable?" gate. */
export interface LockedPlan extends PlanSnapshot {
  id: Ulid;
  hostCircleId: Ulid;
  venueId: Ulid;
  endsAt: Date | null;
  minGroupSize: number;
  note: string | null;
}

interface RawLockedPlan {
  id: string;
  host_circle_id: string;
  venue_id: string;
  state: PlanState;
  mode: PlanMode | null;
  starts_at: Date | string;
  ends_at: Date | string | null;
  open_spots: number;
  min_group_size: number;
  note: string | null;
  confirmed_host_count: number;
  accepted_guest_count: number;
  held_count: number;
  viable_at: Date | string | null;
  applications_closed_at: Date | string | null;
  cancellation_kind: 'host' | 'non_viable' | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function decodeLocked(row: RawLockedPlan): LockedPlan {
  return {
    id: row.id,
    hostCircleId: row.host_circle_id,
    venueId: row.venue_id,
    state: row.state,
    mode: row.mode,
    startsAt: toDate(row.starts_at),
    endsAt: toDateOrNull(row.ends_at),
    openSpots: row.open_spots,
    minGroupSize: row.min_group_size,
    note: row.note,
    confirmedHostCount: row.confirmed_host_count,
    acceptedGuestCount: row.accepted_guest_count,
    heldCount: row.held_count,
    viableAt: toDateOrNull(row.viable_at),
    applicationsClosedAt: toDateOrNull(row.applications_closed_at),
    cancellationKind: row.cancellation_kind,
  };
}

export interface CreatePlanInput {
  hostCircleId: Ulid;
  venueId: Ulid;
  /** Copied from the venue row by the caller — never client input (A2 decision). */
  district: string;
  /** Copied from the venue row by the caller — never client input (A2 decision). */
  venueType: string;
  startsAt: Date;
  endsAt: Date | null;
  openSpots: number;
  minGroupSize: number;
  note: string | null;
}

export type CreatePlanOutcome = { ok: true; id: Ulid } | { ok: false; reason: 'infeasible' };

/**
 * `POST /plans`: a `draft` plan (no `mode` yet). `docs/api.md` has create
 * enforce `MIN_HOST_CIRCLE` / `MIN_PLAN_TOTAL`; `hostCount` (the true active
 * host-circle membership) drives the same `canPublish` predicate the reducer
 * uses at publish, so an infeasible plan is rejected up front as well as at
 * publish. `MIN_HOST_CIRCLE` is structurally satisfied — the creator is the
 * circle's active lead — so only the `MIN_PLAN_TOTAL` half can fail here.
 */
export async function createDraftPlan(
  executor: ActorTransaction,
  input: CreatePlanInput,
  hostCount: number,
): Promise<CreatePlanOutcome> {
  if (!canPublish(hostCount, input.openSpots)) return { ok: false, reason: 'infeasible' };
  const id = ulid();
  await executor.execute(sql`
    INSERT INTO plan (
      id, host_circle_id, venue_id, starts_at, ends_at, open_spots,
      min_group_size, note, district, venue_type, state
    ) VALUES (
      ${id}, ${input.hostCircleId}, ${input.venueId}, ${input.startsAt},
      ${input.endsAt}, ${input.openSpots}, ${input.minGroupSize}, ${input.note},
      ${input.district}, ${input.venueType}, 'draft'
    )
  `);
  return { ok: true, id };
}

/**
 * The true count of `status = 'active'` host-circle members (recorded A3
 * decision: invited / removed do not count). Goes through the 0011
 * `app_active_host_member_count` SECURITY DEFINER function so a host who has
 * blocked a co-host does not under-count their own circle — the RLS
 * `app_user_visible` filter on `circle_member` would otherwise skew it.
 */
export async function activeHostMemberCount(
  executor: ActorTransaction,
  circleId: Ulid,
): Promise<number> {
  const result = await executor.execute(sql`SELECT app_active_host_member_count(${circleId}) AS n`);
  return (result.rows[0] as { n: number }).n;
}

/** `SELECT ... FOR UPDATE` on a plan for the host lead. Undefined if not visible/lockable. */
export async function lockPlan(
  executor: ActorTransaction,
  planId: Ulid,
): Promise<LockedPlan | undefined> {
  const result = await executor.execute(sql`
    SELECT id, host_circle_id, venue_id, state, mode, starts_at, ends_at,
           open_spots, min_group_size, note, confirmed_host_count,
           accepted_guest_count, held_count, viable_at, applications_closed_at,
           cancellation_kind
      FROM plan
     WHERE id = ${planId}
     FOR UPDATE
  `);
  const row = result.rows[0] as RawLockedPlan | undefined;
  return row ? decodeLocked(row) : undefined;
}

export type PublishOutcome =
  | { ok: true; mode: PlanMode; viable: boolean }
  | { ok: false; reason: string };

/**
 * `POST /plans/:id/publish`. `publish` sets state + mode; `setHostCount` then
 * stamps `confirmed_host_count` from the active host-circle membership.
 *
 * Publish no longer latches `viable_at`: Decision B (docs/state.md Decisions
 * C7b + C7c) requires at least one accepted guest for viability, and a
 * freshly-published plan has none — `computeViableAt` returns `null` on its
 * own, so this needs no special-case here. (This reverses the C3 "host circle
 * alone latches at publish" behaviour; the C3 decision entry records the
 * supersession.) Both reducer calls, one locked transaction.
 */
export async function publishPlan(
  executor: ActorTransaction,
  plan: LockedPlan,
  hostSize: number,
  now: Date,
): Promise<PublishOutcome> {
  let next: PlanSnapshot;
  try {
    next = transitionPlan(plan, { type: 'publish', hostSize, now });
    next = transitionPlan(next, { type: 'setHostCount', confirmedHostCount: hostSize, now });
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, reason: error.message };
    throw error;
  }
  await executor.execute(sql`
    UPDATE plan
       SET state = ${next.state},
           mode = ${next.mode},
           published_at = ${now},
           confirmed_host_count = ${next.confirmedHostCount},
           viable_at = ${next.viableAt}
     WHERE id = ${plan.id}
  `);
  return { ok: true, mode: next.mode as PlanMode, viable: next.viableAt !== null };
}

export interface EditPlanFields {
  venueId?: Ulid;
  /** Set by the caller alongside `venueId`, resolved from the venue row. */
  district?: string;
  /** Set by the caller alongside `venueId`, resolved from the venue row. */
  venueType?: string;
  startsAt?: Date;
  endsAt?: Date | null;
  openSpots?: number;
  minGroupSize?: number;
  note?: string | null;
}

export type EditPlanOutcome = 'edited' | 'not_editable' | 'locked' | 'invalid_times';

/**
 * `PATCH /plans/:id`. Editable while `draft`, or `published` with nothing held,
 * accepted, or latched. Once `held_count > 0`, `accepted_guest_count > 0`, or
 * `viable_at` is set, venue / start / end / minimum group size are frozen and
 * `open_spots` may only rise (docs/state.md Decisions C3); `note` stays editable
 * until applications close. `district` / `venue_type` are recopied from the new
 * venue by the caller, never taken from the client.
 */
export async function editPlan(
  executor: ActorTransaction,
  plan: LockedPlan,
  fields: EditPlanFields,
): Promise<EditPlanOutcome> {
  if (plan.state !== 'draft' && plan.state !== 'published') return 'not_editable';

  const effectiveStartsAt = fields.startsAt ?? plan.startsAt;
  const effectiveEndsAt = fields.endsAt !== undefined ? fields.endsAt : plan.endsAt;
  if (effectiveEndsAt !== null && effectiveEndsAt.getTime() <= effectiveStartsAt.getTime()) {
    return 'invalid_times';
  }

  const locked = plan.heldCount > 0 || plan.acceptedGuestCount > 0 || plan.viableAt !== null;
  if (locked) {
    const touchesFrozen =
      fields.venueId !== undefined ||
      fields.startsAt !== undefined ||
      fields.endsAt !== undefined ||
      fields.minGroupSize !== undefined;
    const lowersSpots = fields.openSpots !== undefined && fields.openSpots < plan.openSpots;
    if (touchesFrozen || lowersSpots) return 'locked';
  }

  const sets: SQL[] = [];
  if (fields.venueId !== undefined) {
    sets.push(sql`venue_id = ${fields.venueId}`);
    sets.push(sql`district = ${fields.district}`);
    sets.push(sql`venue_type = ${fields.venueType}`);
  }
  if (fields.startsAt !== undefined) sets.push(sql`starts_at = ${fields.startsAt}`);
  if (fields.endsAt !== undefined) sets.push(sql`ends_at = ${fields.endsAt}`);
  if (fields.openSpots !== undefined) sets.push(sql`open_spots = ${fields.openSpots}`);
  if (fields.minGroupSize !== undefined) sets.push(sql`min_group_size = ${fields.minGroupSize}`);
  if (fields.note !== undefined) sets.push(sql`note = ${fields.note}`);

  if (sets.length === 0) return 'edited';

  await executor.execute(sql`UPDATE plan SET ${sql.join(sets, sql`, `)} WHERE id = ${plan.id}`);
  return 'edited';
}

export type CancelOutcome = 'cancelled' | 'not_cancellable';

/** `POST /plans/:id/cancel`: host cancellation. Valid from draft/published/applications_closed. */
export async function cancelPlan(
  executor: ActorTransaction,
  plan: LockedPlan,
  now: Date,
): Promise<CancelOutcome> {
  let next: PlanSnapshot;
  try {
    next = transitionPlan(plan, { type: 'cancel', now });
  } catch (error) {
    if (error instanceof DomainError) return 'not_cancellable';
    throw error;
  }
  await executor.execute(sql`
    UPDATE plan
       SET state = ${next.state},
           cancelled_at = ${now},
           cancellation_kind = ${next.cancellationKind}
     WHERE id = ${plan.id}
  `);
  return 'cancelled';
}

export type CloseOutcome = 'closed' | 'not_open';

/**
 * `POST /plans/:id/close`: the host manually closes applications
 * (`host_closed` trigger — valid only from `published`).
 */
export async function closePlanApplications(
  executor: ActorTransaction,
  plan: LockedPlan,
  now: Date,
): Promise<CloseOutcome> {
  let next: PlanSnapshot;
  try {
    next = transitionPlan(plan, { type: 'close', trigger: 'host_closed', now });
  } catch (error) {
    if (error instanceof DomainError) return 'not_open';
    throw error;
  }
  await executor.execute(sql`
    UPDATE plan
       SET state = ${next.state},
           applications_closed_at = ${next.applicationsClosedAt}
     WHERE id = ${plan.id}
  `);
  return 'closed';
}

/**
 * E1 worker persist path — no HTTP endpoint (docs/api.md has none; the
 * scheduled job in todo_agent.md E1 is the only caller). Application closure at
 * `starts_at`: stamps `applications_closed_at` if unset and cancels a
 * non-viable plan, never routing a viable plan through `applications_closed`
 * (docs/modes.md; docs/state.md Decisions A6).
 */
export async function closePlanAtStartsAt(
  executor: ActorTransaction,
  plan: LockedPlan,
  now: Date,
): Promise<PlanState> {
  const next = transitionPlan(plan, { type: 'close', trigger: 'starts_at', now });
  if (next.state === 'cancelled') {
    await executor.execute(sql`
      UPDATE plan
         SET state = 'cancelled',
             applications_closed_at = ${next.applicationsClosedAt},
             cancelled_at = ${now},
             cancellation_kind = ${next.cancellationKind}
       WHERE id = ${plan.id}
    `);
  } else {
    await executor.execute(sql`
      UPDATE plan SET applications_closed_at = ${next.applicationsClosedAt} WHERE id = ${plan.id}
    `);
  }
  return next.state;
}

export type CompleteOutcome = 'completed' | 'not_completable';

/**
 * Runs `fn` with the transaction's `app.actor_id` GUC temporarily set to
 * `system:<label>`, restoring the caller's actor id afterward. The 0014
 * `circle_system_record_*` policies gate the record-counter writes on
 * `app_current_actor_id() LIKE 'system:%'`, and a guest circle is neither led
 * by nor visible to the completing host lead — so the counter UPDATEs must run
 * under a system identity even inside a user transaction (docs/state.md
 * Decisions C7b + C7c). When E1's worker eventually runs `completePlan` as
 * `SYSTEM_ACTOR` this swap is a harmless no-op.
 */
async function asSystemActor<T>(
  executor: ActorTransaction,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = (await executor.execute(sql`SELECT current_setting('app.actor_id', true) AS v`))
    .rows[0] as { v: string | null };
  await executor.execute(sql`SELECT set_config('app.actor_id', ${`system:${label}`}, true)`);
  try {
    return await fn();
  } finally {
    await executor.execute(sql`SELECT set_config('app.actor_id', ${prev?.v ?? ''}, true)`);
  }
}

/**
 * E1 worker persist path — no HTTP endpoint. `complete` requires the plan to be
 * past `starts_at` and viable; a non-viable plan has necessarily already been
 * cancelled by `closePlanAtStartsAt` (docs/state.md Decisions A6).
 *
 * On completion the circle record counters are banked (Decision C, docs/state.md
 * Decisions C7b + C7c): `circle.plans_hosted += 1` for the host circle, and
 * `circle.plans_attended += 1` for every distinct guest circle holding an
 * accepted (planned) or approved (tonight) application on this plan. Solo
 * guests have no circle, so nothing accrues for them. `no_shows` /
 * `late_declines` are signal-class and are never granted. The counter writes go
 * through a system actor (`asSystemActor`) against the 0014 policies.
 */
export async function completePlan(
  executor: ActorTransaction,
  plan: LockedPlan,
  now: Date,
): Promise<CompleteOutcome> {
  let next: PlanSnapshot;
  try {
    next = transitionPlan(plan, { type: 'complete', now });
  } catch (error) {
    if (error instanceof DomainError) return 'not_completable';
    throw error;
  }
  await executor.execute(sql`
    UPDATE plan SET state = ${next.state}, completed_at = ${now} WHERE id = ${plan.id}
  `);

  // Distinct guest circles with a live accepted/approved application — read
  // under the caller's actor (a host-circle member can see the plan's
  // applications via application_app_read).
  const guestCircleRows = (
    await executor.execute(sql`
      SELECT DISTINCT applicant_circle_id AS "circleId"
        FROM application
       WHERE plan_id = ${plan.id}
         AND applicant_circle_id IS NOT NULL
         AND (
           (mode = 'planned' AND state = 'accepted')
           OR (mode = 'tonight' AND state = 'approved')
         )
    `)
  ).rows as { circleId: string }[];

  await asSystemActor(executor, 'complete_plan', async () => {
    await executor.execute(sql`
      UPDATE circle SET plans_hosted = plans_hosted + 1 WHERE id = ${plan.hostCircleId}
    `);
    for (const { circleId } of guestCircleRows) {
      await executor.execute(sql`
        UPDATE circle SET plans_attended = plans_attended + 1 WHERE id = ${circleId}
      `);
    }
  });

  return 'completed';
}
