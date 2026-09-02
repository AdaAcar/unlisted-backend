import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Native Postgres enums. Using DB enums (rather than free text + application
 * checks) makes "valid state enums" a database-level guarantee, per todo A2.
 */

export const verificationStateEnum = pgEnum('verification_state', [
  'none',
  'pending',
  'verified',
  'failed',
]);

export const userStandingEnum = pgEnum('user_standing', [
  'good',
  'restricted',
  'suspended',
  'banned',
]);

export const circleMemberRoleEnum = pgEnum('circle_member_role', ['lead', 'member']);

export const circleMemberStatusEnum = pgEnum('circle_member_status', [
  'invited',
  'active',
  'removed',
]);

export const venueTypeEnum = pgEnum('venue_type', ['bar', 'restaurant', 'club', 'beach', 'cafe']);

export const planStateEnum = pgEnum('plan_state', [
  'draft',
  'published',
  'applications_closed',
  'completed',
  'cancelled',
]);

/** Shared by `plan.mode` and `application.mode` (denormalised, same value set). */
export const modeEnum = pgEnum('mode', ['planned', 'tonight']);

export const planCancellationKindEnum = pgEnum('plan_cancellation_kind', ['host', 'non_viable']);

/**
 * Union of the planned and tonight application machines (docs/modes.md). Which
 * subset is legal is enforced per row by a mode-scoped CHECK on `application`.
 */
export const applicationStateEnum = pgEnum('application_state', [
  // planned
  'draft',
  'awaiting_confirmation',
  'submitted',
  'shortlisted',
  'invited',
  'accepted',
  'declined',
  'expired',
  'rejected',
  'withdrawn',
  // tonight-only
  'approved',
]);

export const applicationMemberConfirmationStateEnum = pgEnum(
  'application_member_confirmation_state',
  ['unconfirmed', 'confirmed'],
);

export const applicationMemberInvitationStateEnum = pgEnum('application_member_invitation_state', [
  'not_invited',
  'invited',
  'accepted',
  'declined',
  'expired',
]);

export const signalKindEnum = pgEnum('signal_kind', [
  'report',
  'non_return',
  'early_departure',
  'low_response',
  'no_show',
]);

export const auditActorRoleEnum = pgEnum('audit_actor_role', [
  'user',
  'circle_lead',
  'moderator',
  'system',
]);
