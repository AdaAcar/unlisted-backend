/**
 * Application data-layer entry point: actor-scoped repositories, plus the
 * append-only audit write helper (A4) and the session write path (B1).
 * `recordAuditEntry` and the session functions all take the caller's open
 * transaction rather than a fresh connection — see `db/audit.ts` and
 * `db/session.ts` — so a session write and its audit entry commit or roll
 * back together. `withActor` itself is deliberately not re-exported here:
 * the domain layer that will call this (A6+) must not import from `db/` at
 * all (agent-rules section 4), so composing an executor and calling these
 * helpers happens at the `app/api` boundary (importing `withActor` directly
 * from `@/db/scope/scoped`, same as `db/audit.ts`'s tests already do), not
 * inside `domain/`.
 */
export {
  recordAuditEntry,
  type AuditEntry,
  type SystemAuditEntry,
  type UserAuditEntry,
} from './audit';
export {
  applications,
  circles,
  getApplication,
  getThreadByPlan,
  getVenue,
  listPlanApplications,
  listThreadMessages,
  listVenues,
  plans,
  threads,
  users,
  venues,
  FEED_PAGE_DEFAULT,
  FEED_PAGE_MAX,
  VENUE_TYPES,
  type ApplicationRecord,
  type ApplicationMemberRecord,
  type ApplicationState,
  type FeedCursor,
  type MessageRecord,
  type PlanFeedFilters,
  type ThreadRecord,
  type VenueFilters,
  type VenueRecord,
  type VenueType,
} from './repositories';
export {
  createThreadForViablePlan,
  postMessage,
  type CreateThreadOutcome,
  type PostMessageOutcome,
} from './threads';
export {
  confirmMember,
  createApplication,
  lockApplication,
  rejectApplication,
  shortlistApplication,
  unshortlistApplication,
  withdrawApplication,
  withdrawMember,
  type ConfirmOutcome,
  type CreateApplicationInput,
  type CreateApplicationOutcome,
  type LockedApplication,
  type ReviewOutcome,
  type WithdrawMemberOutcome,
  type WithdrawOutcome,
} from './applications';
export {
  acceptInvitation,
  declineInvitation,
  expireInvitation,
  inviteApplication,
  type AcceptOutcome,
  type DeclineOutcome,
  type InviteOutcome,
} from './invitations';
export {
  acceptCircleInvitation,
  createCircle,
  inviteMember,
  removeCircleMember,
  transferCircleLead,
  type CreatedCircle,
  type InviteMemberResult,
  type RemoveMemberResult,
  type TransferLeadResult,
} from './circles';
export {
  activeHostMemberCount,
  cancelPlan,
  closePlanApplications,
  closePlanAtStartsAt,
  completePlan,
  createDraftPlan,
  editPlan,
  lockPlan,
  publishPlan,
  type CancelOutcome,
  type CloseOutcome,
  type CompleteOutcome,
  type CreatePlanInput,
  type CreatePlanOutcome,
  type EditPlanFields,
  type EditPlanOutcome,
  type LockedPlan,
  type PublishOutcome,
} from './plans';
export {
  authenticate,
  extractSessionToken,
  getSessionActor,
  getSessionContext,
  loadActorByUserId,
  SESSION_COOKIE_NAME,
} from './scope/resolve';
export { createSession, deleteSessionByTokenHash, rotateSession } from './session';
export {
  completeVerification,
  startVerification,
  type CompleteVerificationParams,
} from './verification';
