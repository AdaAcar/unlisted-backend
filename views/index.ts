/**
 * View models: the only shape a client ever receives.
 *
 * One view model per audience per entity (public, contextual, self, moderator).
 * A domain entity is never serialized directly to a client. Adding a field to an
 * entity must not change any response without a deliberate edit here.
 *
 * C1 adds the first real view model (`CircleView`). The full per-audience set
 * arrives in phase F.
 */
export { toCircleView, type CircleView } from './circles';
