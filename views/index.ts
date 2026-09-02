/**
 * View models: the only shape a client ever receives.
 *
 * One view model per audience per entity (public, contextual, self, moderator).
 * A domain entity is never serialized directly to a client. Adding a field to an
 * entity must not change any response without a deliberate edit here.
 *
 * Populated in phase F.
 */
export {};
