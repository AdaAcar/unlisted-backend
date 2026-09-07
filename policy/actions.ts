import type { Actor } from '@/db/scope/actor';

export type Ulid = string;

/**
 * `null` represents an unauthenticated caller (no resolved session). Three
 * docs/api.md endpoints have no session at all: `POST /auth/session` and
 * `POST /auth/recover` are "none"-auth, and `POST /verification/webhook` is
 * authenticated by vendor signature, not a session. `PolicyActor` is
 * additive to `Actor` and lives only in `policy/` -- `db/scope/actor.ts` is
 * unchanged.
 */
export type PolicyActor = Actor | null;

export type Decision = 'allow' | 'deny';

export type CircleRole = 'lead' | 'member';
export type CircleMemberStatus = 'invited' | 'active' | 'removed';
export type PlanMode = 'planned' | 'tonight';

/**
 * One entry per action this module governs: every non-Assembly endpoint in
 * docs/api.md, plus the two docs/modes.md-only additions (`approve`,
 * `close`) that docs/api.md predates and never lists, plus one inferred
 * endpoint neither doc lists (`circle.acceptInvitation`, added in C1 — see
 * `INFERRED_ENDPOINTS`). See `ACTION_ENDPOINTS` below for the exact
 * crosswalk and docs/state.md Decisions (A5, C1) for the 45 + 2 + 1 = 48
 * derivation.
 *
 * Every resource shape here is a set of facts the *caller* already knows --
 * role, membership, mode, ownership, a shared-plan-context boolean. Policy
 * never queries anything (docs/architecture.md's authorization model: one
 * module, three inputs, no query of its own). It also never encodes a
 * state-machine precondition -- capacity, "before invitation", "immutable
 * after first invitation", "after the plan" -- those are domain/state
 * machine concerns (A6), not an actor-resource relationship. See
 * docs/state.md Decisions (A5) for this boundary.
 */
export interface ResourceByAction {
  'auth.session.create': Record<string, never>;
  'auth.session.delete': Record<string, never>;
  'auth.recover': Record<string, never>;

  'verification.start': Record<string, never>;
  'verification.webhook': Record<string, never>;

  'profile.getSelf': Record<string, never>;
  'profile.updateSelf': Record<string, never>;
  'profile.uploadPhoto': Record<string, never>;
  'profile.deletePhoto': { ownerId: Ulid };
  'profile.getUser': { sharesPlanContext: boolean };

  'circle.create': Record<string, never>;
  'circle.get': { membershipStatus: CircleMemberStatus | null };
  'circle.addMember': { actorRole: CircleRole | null };
  'circle.removeMember': { actorRole: CircleRole | null; targetIsSelf: boolean };
  'circle.transferLead': { actorRole: CircleRole | null };
  'circle.acceptInvitation': { membershipStatus: CircleMemberStatus | null };

  'venue.list': Record<string, never>;
  'venue.get': Record<string, never>;

  'plan.create': { actorRole: CircleRole | null };
  'plan.publish': { actorRole: CircleRole | null };
  'plan.list': Record<string, never>;
  'plan.get': { published: boolean; actorHostsCircle: boolean };
  'plan.update': { actorRole: CircleRole | null };
  'plan.cancel': { actorRole: CircleRole | null };
  'plan.close': { actorRole: CircleRole | null };

  'application.create': { applyingAsCircle: boolean; actorRole: CircleRole | null };
  'application.confirm': { planMode: PlanMode; isConfirmingMember: boolean };
  'application.delete': { actorRole: CircleRole | null };
  'application.withdrawMember': { isSelfMember: boolean };
  'application.get': { isApplicantMember: boolean; isHostLead: boolean };

  'review.listApplications': { actorRole: CircleRole | null };
  'application.shortlist': { actorRole: CircleRole | null };
  'application.reject': { actorRole: CircleRole | null };
  'application.invite': { planMode: PlanMode; actorRole: CircleRole | null };
  'application.approve': { planMode: PlanMode; actorRole: CircleRole | null };

  'invitation.accept': { planMode: PlanMode; isInvitee: boolean };
  'invitation.decline': { planMode: PlanMode; isInvitee: boolean };

  // Gated on viability, not "after invitation": docs/modes.md and the
  // viability rule win over docs/api.md's older wording here (a thread may
  // not exist before viable_at is set, which happens strictly after any
  // invitation is accepted -- see docs/state.md Traps on the viable_at latch).
  // `threadParticipant`: the actor is a confirmed participant of the plan's
  // thread — a row in `plan_participant_introduction` for this plan (C8). Named
  // for what it means, not "circle member": with solo applicants a participant
  // need not be in any circle.
  'message.getThread': { threadParticipant: boolean; viable: boolean };
  'message.postThread': { threadParticipant: boolean; viable: boolean };

  'safety.report': { sharesPlanContext: boolean };
  'safety.block': Record<string, never>;
  'safety.unblock': { isBlocker: boolean };
  'safety.feedback': { isAttendee: boolean };
  'safety.supportUrgent': Record<string, never>;

  // `actorIsModerator` is caller-supplied like every other resource fact
  // above -- but unlike those, nothing in this codebase can honestly
  // produce `true` for it yet: moderator capability is not an actor field
  // until D4 (docs/agent-rules.md; this module must not invent one). See
  // docs/state.md Known gaps.
  'moderation.viewQueue': { actorIsModerator: boolean };
  'moderation.viewCase': { actorIsModerator: boolean };
  'moderation.act': { actorIsModerator: boolean };
  'moderation.reviewAppeal': { actorIsModerator: boolean; actingModeratorId: Ulid | null };
}

export type Action = keyof ResourceByAction;

/**
 * Traceability crosswalk: every action to the literal docs/api.md or
 * docs/modes.md endpoint it implements. tests/unit/policy.test.ts checks
 * this table in both directions against an independently transcribed copy
 * of the same endpoint lists, so a missing rule *or* an invented/typo'd one
 * both fail the suite -- a one-directional subset check would only catch
 * the first kind (docs/state.md Decisions, A5).
 */
export const ACTION_ENDPOINTS: Record<Action, string> = {
  'auth.session.create': 'POST /auth/session',
  'auth.session.delete': 'DELETE /auth/session',
  'auth.recover': 'POST /auth/recover',

  'verification.start': 'POST /verification/start',
  'verification.webhook': 'POST /verification/webhook',

  'profile.getSelf': 'GET /me',
  'profile.updateSelf': 'PATCH /me',
  'profile.uploadPhoto': 'POST /me/photos',
  'profile.deletePhoto': 'DELETE /me/photos/:id',
  'profile.getUser': 'GET /users/:id',

  'circle.create': 'POST /circles',
  'circle.get': 'GET /circles/:id',
  'circle.addMember': 'POST /circles/:id/members',
  'circle.removeMember': 'DELETE /circles/:id/members/:userId',
  'circle.transferLead': 'POST /circles/:id/lead',
  'circle.acceptInvitation': 'POST /circles/:id/members/accept',

  'venue.list': 'GET /venues',
  'venue.get': 'GET /venues/:id',

  'plan.create': 'POST /plans',
  'plan.publish': 'POST /plans/:id/publish',
  'plan.list': 'GET /plans',
  'plan.get': 'GET /plans/:id',
  'plan.update': 'PATCH /plans/:id',
  'plan.cancel': 'POST /plans/:id/cancel',
  'plan.close': 'POST /plans/:id/close',

  'application.create': 'POST /plans/:id/applications',
  'application.confirm': 'POST /applications/:id/confirm',
  'application.delete': 'DELETE /applications/:id',
  'application.withdrawMember': 'POST /applications/:id/withdraw-member',
  'application.get': 'GET /applications/:id',

  'review.listApplications': 'GET /plans/:id/applications',
  'application.shortlist': 'POST /applications/:id/shortlist',
  'application.reject': 'POST /applications/:id/reject',
  'application.invite': 'POST /applications/:id/invite',
  'application.approve': 'POST /applications/:id/approve',

  'invitation.accept': 'POST /invitations/:id/accept',
  'invitation.decline': 'POST /invitations/:id/decline',

  'message.getThread': 'GET /plans/:id/thread',
  'message.postThread': 'POST /plans/:id/thread',

  'safety.report': 'POST /reports',
  'safety.block': 'POST /blocks',
  'safety.unblock': 'DELETE /blocks/:id',
  'safety.feedback': 'POST /plans/:id/feedback',
  'safety.supportUrgent': 'POST /support/urgent',

  'moderation.viewQueue': 'GET /mod/queue',
  'moderation.viewCase': 'GET /mod/cases/:id',
  'moderation.act': 'POST /mod/actions',
  'moderation.reviewAppeal': 'POST /mod/appeals/:id',
};

/**
 * Named, not omitted. todo_agent.md A5: "Assembly is deferred and explicitly
 * not built... make sure your completeness test excludes Assembly
 * explicitly and by name -- not by silently omitting it." These three
 * endpoints exist in docs/api.md and have no rule, deliberately.
 */
export const ASSEMBLY_ENDPOINTS = [
  'POST /plans/:id/assembly/join',
  'POST /assemblies/:id/confirm',
  'DELETE /assemblies/:id/leave',
] as const;

/** The two docs/modes.md endpoints with no row in docs/api.md at all. */
export const MODE_ONLY_ENDPOINTS = [
  'POST /applications/:id/approve',
  'POST /plans/:id/close',
] as const;

/**
 * Endpoints this codebase adds that neither docs/api.md nor docs/modes.md
 * lists. C1: the invitee accepting a circle invitation is their own action,
 * but docs/api.md's Circles section states "Invitee must accept" only as a
 * rule on the lead-only `POST /circles/:id/members` row and gives it no
 * endpoint of its own. Named here, not smuggled in, so the completeness
 * test still checks both directions. See docs/state.md Decisions (C1).
 */
export const INFERRED_ENDPOINTS = ['POST /circles/:id/members/accept'] as const;

/** Actions whose rule reads `resource.planMode`; the wrong mode always denies. */
export const MODE_SCOPED_ACTIONS: readonly Action[] = [
  'application.confirm',
  'application.invite',
  'application.approve',
  'invitation.accept',
  'invitation.decline',
];
