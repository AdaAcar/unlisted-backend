import type { PlanRecord } from '@/db/repositories/plans';

/**
 * The third view model (C3), following `CircleView` / `VenueView`. One shape,
 * for the audiences C3 serves: the host circle lead (create / publish / edit /
 * cancel / close responses) and any authenticated viewer of a published plan
 * (`GET /plans/:id`).
 *
 * Deliberately excluded (agent-rules section 3; docs/modes.md "they do not see
 * each other"):
 *
 * - `confirmed_host_count` / `accepted_guest_count` / `held_count` and the
 *   generated `confirmed_total` — raw attendance counts. Before viability a
 *   guest must not learn how many others applied; after viability the group is
 *   revealed through the thread and the C6 review surface, not here. `viable`
 *   is the only attendance-derived fact this view carries.
 * - `published_at` / `cancelled_at` / `completed_at` timestamps — lifecycle
 *   detail with no consumer yet. `state` and the two booleans below are enough
 *   for a plan card.
 *
 * F1 forks this per audience (public / contextual / self / moderator) and adds
 * host-only capacity fields there if a real need appears — do not add them now.
 */
export interface PlanView {
  id: string;
  hostCircleId: string;
  venueId: string;
  district: string;
  venueType: PlanRecord['venueType'];
  startsAt: string;
  endsAt: string | null;
  openSpots: number;
  minGroupSize: number;
  note: string | null;
  state: PlanRecord['state'];
  mode: PlanRecord['mode'];
  /** `viable_at IS NOT NULL` — the introduction has occurred (docs/modes.md). */
  viable: boolean;
  /** Any of the three closure conditions has fired (docs/modes.md). */
  applicationsClosed: boolean;
  cancellationKind: PlanRecord['cancellationKind'];
}

export function toPlanView(plan: PlanRecord): PlanView {
  return {
    id: plan.id,
    hostCircleId: plan.hostCircleId,
    venueId: plan.venueId,
    district: plan.district,
    venueType: plan.venueType,
    startsAt: plan.startsAt.toISOString(),
    endsAt: plan.endsAt === null ? null : plan.endsAt.toISOString(),
    openSpots: plan.openSpots,
    minGroupSize: plan.minGroupSize,
    note: plan.note,
    state: plan.state,
    mode: plan.mode,
    viable: plan.viableAt !== null,
    applicationsClosed: plan.applicationsClosedAt !== null,
    cancellationKind: plan.cancellationKind,
  };
}

/**
 * The discovery-feed row (C4) — leaner than `PlanView`, because the feed is the
 * codebase's most exposed scrape target (docs/security.md: enumeration is the
 * top threat, keep attendee lists out of the feed). Deliberately dropped
 * relative to `PlanView`: `hostCircleId` (a circle handle a stranger has no use
 * for — `GET /circles/:id` is members-only anyway), `state` (always `published`
 * here), and every attendance-derived field including `viable` (a searcher sees
 * a plan as pending, never who is in it). Venue name/address are not here
 * either — the client resolves `venueId` through the public venue registry.
 */
export interface PlanFeedView {
  id: string;
  venueId: string;
  district: string;
  venueType: PlanRecord['venueType'];
  startsAt: string;
  endsAt: string | null;
  openSpots: number;
  minGroupSize: number;
  note: string | null;
  mode: PlanRecord['mode'];
}

export function toPlanFeedView(plan: PlanRecord): PlanFeedView {
  return {
    id: plan.id,
    venueId: plan.venueId,
    district: plan.district,
    venueType: plan.venueType,
    startsAt: plan.startsAt.toISOString(),
    endsAt: plan.endsAt === null ? null : plan.endsAt.toISOString(),
    openSpots: plan.openSpots,
    minGroupSize: plan.minGroupSize,
    note: plan.note,
    mode: plan.mode,
  };
}
