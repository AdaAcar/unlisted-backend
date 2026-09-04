import type { UserActor } from '@/db/scope/actor';

import type { Action, PolicyActor, ResourceByAction } from './actions';

type Rule<A extends Action> = (actor: PolicyActor, resource: ResourceByAction[A]) => boolean;

type RuleTable = { [A in Action]: Rule<A> };

function isUser(actor: PolicyActor): actor is UserActor {
  return actor !== null && actor.kind === 'user';
}

function isVerified(actor: UserActor): boolean {
  return actor.verificationState === 'verified';
}

function isGoodStanding(actor: UserActor): boolean {
  return actor.standing === 'good';
}

/**
 * The rule table: data, not a chain of conditionals. One entry per action in
 * `./actions`, each a pure function of (actor, resource facts) -> boolean.
 * `RuleTable` is an exhaustive mapped type over `Action`, so omitting an
 * entry is a compile error here, not only a runtime one; `./index`'s
 * `policy()` additionally enforces deny-by-default at the call boundary,
 * where an action can arrive that bypassed this type entirely.
 */
export const rules: RuleTable = {
  'auth.session.create': () => true,
  'auth.session.delete': (actor) => isUser(actor),
  'auth.recover': () => true,

  'verification.start': (actor) => isUser(actor),
  'verification.webhook': () => true,

  'profile.getSelf': (actor) => isUser(actor),
  'profile.updateSelf': (actor) => isUser(actor),
  'profile.uploadPhoto': (actor) => isUser(actor) && isVerified(actor),
  'profile.deletePhoto': (actor, resource) => isUser(actor) && actor.id === resource.ownerId,
  'profile.getUser': (actor, resource) => isUser(actor) && resource.sharesPlanContext,

  'circle.create': (actor) => isUser(actor) && isVerified(actor),
  'circle.get': (actor, resource) => isUser(actor) && resource.membershipStatus === 'active',
  'circle.addMember': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',
  'circle.removeMember': (actor, resource) =>
    isUser(actor) &&
    (resource.actorRole === 'lead' || (resource.targetIsSelf && resource.actorRole !== null)),
  'circle.transferLead': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',

  'venue.list': (actor) => isUser(actor),
  'venue.get': (actor) => isUser(actor),

  'plan.create': (actor, resource) =>
    isUser(actor) && isVerified(actor) && isGoodStanding(actor) && resource.actorRole === 'lead',
  'plan.publish': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',
  'plan.list': (actor) => isUser(actor),
  'plan.get': (actor, resource) =>
    isUser(actor) && (resource.published || resource.actorHostsCircle),
  'plan.update': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',
  'plan.cancel': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',
  'plan.close': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',

  'application.create': (actor, resource) =>
    isUser(actor) &&
    isVerified(actor) &&
    isGoodStanding(actor) &&
    (!resource.applyingAsCircle || resource.actorRole === 'lead'),
  'application.confirm': (actor, resource) =>
    isUser(actor) && resource.planMode === 'planned' && resource.isConfirmingMember,
  'application.delete': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',
  'application.withdrawMember': (actor, resource) => isUser(actor) && resource.isSelfMember,
  'application.get': (actor, resource) =>
    isUser(actor) && (resource.isApplicantMember || resource.isHostLead),

  'review.listApplications': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',
  'application.shortlist': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',
  'application.reject': (actor, resource) => isUser(actor) && resource.actorRole === 'lead',
  'application.invite': (actor, resource) =>
    isUser(actor) && resource.planMode === 'planned' && resource.actorRole === 'lead',
  'application.approve': (actor, resource) =>
    isUser(actor) && resource.planMode === 'tonight' && resource.actorRole === 'lead',

  'invitation.accept': (actor, resource) =>
    isUser(actor) && resource.planMode === 'planned' && resource.isInvitee,
  'invitation.decline': (actor, resource) =>
    isUser(actor) && resource.planMode === 'planned' && resource.isInvitee,

  'message.getThread': (actor, resource) =>
    isUser(actor) && resource.actorIsCircleMember && resource.viable,
  'message.postThread': (actor, resource) =>
    isUser(actor) && resource.actorIsCircleMember && resource.viable,

  'safety.report': (actor, resource) => isUser(actor) && resource.sharesPlanContext,
  'safety.block': (actor) => isUser(actor),
  'safety.unblock': (actor, resource) => isUser(actor) && resource.isBlocker,
  'safety.feedback': (actor, resource) => isUser(actor) && resource.isAttendee,
  'safety.supportUrgent': (actor) => isUser(actor),

  'moderation.viewQueue': (actor, resource) => isUser(actor) && resource.actorIsModerator,
  'moderation.viewCase': (actor, resource) => isUser(actor) && resource.actorIsModerator,
  'moderation.act': (actor, resource) => isUser(actor) && resource.actorIsModerator,
  'moderation.reviewAppeal': (actor, resource) =>
    isUser(actor) &&
    resource.actorIsModerator &&
    (resource.actingModeratorId === null || actor.id !== resource.actingModeratorId),
};
