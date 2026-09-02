/**
 * Product parameters for Unlisted.
 *
 * Every product parameter lives in this file (CLAUDE.md section 5). Never inline
 * one of these values anywhere else.
 *
 * These values are NOT readable from the environment. There is deliberately no
 * `process.env` fallback, no override path, and no merge step. They are
 * structural invariants, not deployment configuration. `MIN_PLAN_TOTAL` in
 * particular is the floor that stops a plan ever becoming a two-person meeting;
 * it must not be movable by whoever controls the deployment.
 *
 * Infrastructure configuration (database URL, Redis URL, session secrets) does
 * not belong here. It will live in a separate environment module, added by the
 * task that first needs it, and it will never be merged into `config`.
 */
export const config = {
  /** Minimum confirmed members in a hosting circle. Convenience floor; may move. */
  MIN_HOST_CIRCLE: 1,

  /** Minimum members in an applying circle. Convenience floor; may move. */
  MIN_APPLICANT_CIRCLE: 1,

  /**
   * Minimum confirmed attendees (confirmed host members + accepted guests) for a
   * plan to become viable. Structural invariant: never lower it, never add a
   * path that bypasses it.
   */
  MIN_PLAN_TOTAL: 3,

  /**
   * Hours between `now` and `starts_at`, measured once at publish, at or above
   * which a plan runs in `planned` mode; below it, `tonight` mode.
   */
  SPONTANEOUS_THRESHOLD_H: 24,

  /** Upper clamp on a computed invitation response deadline, in hours. */
  RESPONSE_DEADLINE_MAX_H: 12,

  /** Lower clamp on a computed invitation response deadline, in minutes. */
  RESPONSE_DEADLINE_MIN_M: 15,

  /** Fraction of the remaining time-to-start used to size a response deadline. */
  RESPONSE_DEADLINE_RATIO: 0.25,
} as const;

export type Config = typeof config;
