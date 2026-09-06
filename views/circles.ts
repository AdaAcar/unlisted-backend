import type { CircleRecord } from '@/db/repositories/circles';

/**
 * The first real view model (C1). One shape, for the only audience C1 serves:
 * an active member of the circle (`GET /circles/:id`). F1 forks this per
 * audience (public / contextual / self / moderator) — do not add those here.
 *
 * `circle`'s record counters never reach this boundary: `no_shows` and
 * `late_declines` are signal-category fields (kept out of view models, like
 * `Record.signal_score` and venue `licence_ref`), and `plans_hosted` /
 * `plans_attended` are simply not needed by any C1 response. `CircleRecord`
 * does not carry them, so there is nothing here to drop. See docs/state.md
 * Decisions (C1).
 */
export interface CircleView {
  id: string;
  name: string;
  leadUserId: string;
  memberIds: string[];
}

export function toCircleView(circle: CircleRecord): CircleView {
  return {
    id: circle.id,
    name: circle.name,
    leadUserId: circle.leadUserId,
    memberIds: circle.memberIds,
  };
}
