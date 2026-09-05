/**
 * Shared primitives for the domain layer (task A6).
 *
 * `Ulid` and `PlanMode` intentionally duplicate the shape already declared in
 * `db/schema/enums.ts` (`modeEnum`) and `policy/actions.ts` (`Ulid`, `PlanMode`)
 * rather than import across the domain/DB or domain/policy boundary --
 * agent-rules section 4 forbids a DB import in `domain/`, and A6 does not
 * import `policy/` either (A5 decision: policy answers who may act, A6 owns
 * state preconditions). See docs/state.md Decisions (A6).
 */
export type Ulid = string;

export type PlanMode = 'planned' | 'tonight';

/** Thrown for any invalid state/action pair or guard violation in a machine. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
