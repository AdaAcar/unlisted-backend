/**
 * Domain layer: entities, state machines, and invariants.
 *
 * Pure where possible. No database imports, no framework imports. Route handlers
 * call into this layer; this layer calls nothing above it.
 *
 * A6 (state machines): the plan machine plus the two application machines
 * (planned, tonight). No Assembly machine -- deferred per agent-rules section 5.
 */
export * from './types';
export * from './plan';
export * from './application-planned';
export * from './application-tonight';
