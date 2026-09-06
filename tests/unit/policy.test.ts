import { describe, expect, it } from 'vitest';

import type { Actor, UserActor } from '@/db/scope/actor';
import {
  ACTION_ENDPOINTS,
  ASSEMBLY_ENDPOINTS,
  INFERRED_ENDPOINTS,
  MODE_ONLY_ENDPOINTS,
  MODE_SCOPED_ACTIONS,
  policy,
  type Action,
} from '@/policy';

/**
 * Fixtures. `id` values are plausible-looking ULIDs; policy never validates
 * ULID shape (that is a schema/Zod concern), so any distinct strings work,
 * but ULID-shaped ids keep these fixtures honest about the actor shape.
 */
const HOST: UserActor = {
  kind: 'user',
  id: '01HOSTUSER00000000000000A',
  verificationState: 'verified',
  standing: 'good',
};
const OTHER: UserActor = {
  kind: 'user',
  id: '01OTHERUSER0000000000000B',
  verificationState: 'verified',
  standing: 'good',
};
const UNVERIFIED: UserActor = {
  kind: 'user',
  id: '01UNVERIFIEDUSER000000000C',
  verificationState: 'none',
  standing: 'good',
};
const RESTRICTED: UserActor = {
  kind: 'user',
  id: '01RESTRICTEDUSER00000000D',
  verificationState: 'verified',
  standing: 'restricted',
};
const BANNED: UserActor = {
  kind: 'user',
  id: '01BANNEDUSER0000000000000E',
  verificationState: 'verified',
  standing: 'banned',
};
const ANON: Actor | null = null;

describe('policy table completeness', () => {
  // Independently transcribed from docs/api.md, excluding the Assembly
  // section (line 124) -- this list must NOT be derived from policy/actions.ts,
  // or a typo'd/invented rule there would never be caught. 45 entries.
  const API_ENDPOINTS = [
    'POST /auth/session',
    'DELETE /auth/session',
    'POST /auth/recover',
    'POST /verification/start',
    'POST /verification/webhook',
    'GET /me',
    'PATCH /me',
    'POST /me/photos',
    'DELETE /me/photos/:id',
    'GET /users/:id',
    'POST /circles',
    'GET /circles/:id',
    'POST /circles/:id/members',
    'DELETE /circles/:id/members/:userId',
    'POST /circles/:id/lead',
    'GET /venues',
    'GET /venues/:id',
    'POST /plans',
    'POST /plans/:id/publish',
    'GET /plans',
    'GET /plans/:id',
    'PATCH /plans/:id',
    'POST /plans/:id/cancel',
    'POST /plans/:id/applications',
    'POST /applications/:id/confirm',
    'DELETE /applications/:id',
    'POST /applications/:id/withdraw-member',
    'GET /applications/:id',
    'GET /plans/:id/applications',
    'POST /applications/:id/shortlist',
    'POST /applications/:id/reject',
    'POST /applications/:id/invite',
    'POST /invitations/:id/accept',
    'POST /invitations/:id/decline',
    'GET /plans/:id/thread',
    'POST /plans/:id/thread',
    'POST /reports',
    'POST /blocks',
    'DELETE /blocks/:id',
    'POST /plans/:id/feedback',
    'POST /support/urgent',
    'GET /mod/queue',
    'GET /mod/cases/:id',
    'POST /mod/actions',
    'POST /mod/appeals/:id',
  ] as const;

  // The only two endpoints modes.md adds that api.md never had at all
  // (docs/modes.md "API deltas", lines 135 and 138).
  const MODE_ONLY_GROUND_TRUTH = [
    'POST /applications/:id/approve',
    'POST /plans/:id/close',
  ] as const;

  // Named, not omitted (todo_agent.md A5: Assembly is deferred and must be
  // excluded "by name", not by silent absence).
  const ASSEMBLY_GROUND_TRUTH = [
    'POST /plans/:id/assembly/join',
    'POST /assemblies/:id/confirm',
    'DELETE /assemblies/:id/leave',
  ] as const;

  // Endpoints neither doc lists. C1 added the invitee's own acceptance of a
  // circle invitation (docs/api.md states "Invitee must accept" as a rule on
  // the lead-only invite row, with no endpoint of its own).
  const INFERRED_GROUND_TRUTH = ['POST /circles/:id/members/accept'] as const;

  it('derives to exactly 48 actions: 45 from api.md, 2 modes.md-only, 1 inferred (C1)', () => {
    expect(API_ENDPOINTS).toHaveLength(45);
    expect(MODE_ONLY_GROUND_TRUTH).toHaveLength(2);
    expect(INFERRED_GROUND_TRUTH).toHaveLength(1);
    expect(Object.keys(ACTION_ENDPOINTS)).toHaveLength(48);
  });

  it('has a rule for every non-Assembly docs/api.md endpoint (direction 1: nothing missing)', () => {
    const implemented = new Set(Object.values(ACTION_ENDPOINTS));
    for (const endpoint of API_ENDPOINTS) {
      expect(implemented.has(endpoint)).toBe(true);
    }
  });

  it('maps every rule to a named api.md endpoint, a named modes.md-only action, or a named inferred endpoint (direction 2: nothing invented)', () => {
    const known = new Set<string>([
      ...API_ENDPOINTS,
      ...MODE_ONLY_GROUND_TRUTH,
      ...INFERRED_GROUND_TRUTH,
    ]);
    for (const endpoint of Object.values(ACTION_ENDPOINTS)) {
      expect(known.has(endpoint)).toBe(true);
    }
  });

  it('exports MODE_ONLY_ENDPOINTS matching exactly the two modes.md additions', () => {
    expect(new Set(MODE_ONLY_ENDPOINTS)).toEqual(new Set(MODE_ONLY_GROUND_TRUTH));
  });

  it('exports INFERRED_ENDPOINTS matching exactly the one C1 addition', () => {
    expect(new Set(INFERRED_ENDPOINTS)).toEqual(new Set(INFERRED_GROUND_TRUTH));
  });

  it('names Assembly endpoints explicitly and excludes every one of them from the rule table', () => {
    expect(new Set(ASSEMBLY_ENDPOINTS)).toEqual(new Set(ASSEMBLY_GROUND_TRUTH));
    const implemented = new Set(Object.values(ACTION_ENDPOINTS));
    for (const endpoint of ASSEMBLY_GROUND_TRUTH) {
      expect(implemented.has(endpoint)).toBe(false);
    }
  });

  it('denies an action with no entry in the rule table', () => {
    const bogus = 'plan.teleport' as unknown as Action;
    expect(policy(HOST, bogus, {} as never)).toBe('deny');
  });
});

describe('policy: unconditional actions (api.md Auth = "none" or "vendor signature")', () => {
  // These three have no actor-based condition in api.md at all -- login,
  // password recovery, and a vendor-signature-verified webhook are all
  // reachable by definition without a resolved actor. There is no deny path
  // to test because the rule does not gate on anything; each case below
  // instead proves the rule is truly actor-independent, across an
  // unauthenticated caller and a banned one.
  it.each([
    ['auth.session.create', ANON],
    ['auth.session.create', BANNED],
    ['auth.recover', ANON],
    ['auth.recover', BANNED],
    ['verification.webhook', ANON],
    ['verification.webhook', BANNED],
  ] as const)('%s allows regardless of actor (%s)', (action, actor) => {
    expect(policy(actor, action, {})).toBe('allow');
  });
});

describe('policy: authenticated-only actions', () => {
  const AUTHENTICATED_ONLY_ACTIONS = [
    'auth.session.delete',
    'verification.start',
    'profile.getSelf',
    'profile.updateSelf',
    'venue.list',
    'venue.get',
    'plan.list',
    'safety.block',
    'safety.supportUrgent',
  ] as const;

  it.each(AUTHENTICATED_ONLY_ACTIONS)('%s allows any authenticated user', (action) => {
    expect(policy(HOST, action, {})).toBe('allow');
  });

  it.each(AUTHENTICATED_ONLY_ACTIONS)('%s denies an unauthenticated caller', (action) => {
    expect(policy(ANON, action, {})).toBe('deny');
  });
});

describe('policy: verified-only actions', () => {
  it('circle.create allows a verified user', () => {
    expect(policy(HOST, 'circle.create', {})).toBe('allow');
  });
  it('circle.create denies an unverified user', () => {
    expect(policy(UNVERIFIED, 'circle.create', {})).toBe('deny');
  });
  it('circle.create denies an unauthenticated caller', () => {
    expect(policy(ANON, 'circle.create', {})).toBe('deny');
  });

  it('profile.uploadPhoto allows a verified user', () => {
    expect(policy(HOST, 'profile.uploadPhoto', {})).toBe('allow');
  });
  it('profile.uploadPhoto denies an unverified user', () => {
    expect(policy(UNVERIFIED, 'profile.uploadPhoto', {})).toBe('deny');
  });
});

describe('policy: profile', () => {
  it('profile.deletePhoto allows the owner', () => {
    expect(policy(HOST, 'profile.deletePhoto', { ownerId: HOST.id })).toBe('allow');
  });
  it('profile.deletePhoto denies a non-owner', () => {
    expect(policy(OTHER, 'profile.deletePhoto', { ownerId: HOST.id })).toBe('deny');
  });

  it('profile.getUser allows an actor who shares a plan context with the subject', () => {
    expect(policy(HOST, 'profile.getUser', { sharesPlanContext: true })).toBe('allow');
  });
  it('profile.getUser denies an actor with no shared plan context', () => {
    expect(policy(HOST, 'profile.getUser', { sharesPlanContext: false })).toBe('deny');
  });
});

describe('policy: circles', () => {
  it('circle.get allows an active member', () => {
    expect(policy(HOST, 'circle.get', { membershipStatus: 'active' })).toBe('allow');
  });
  it('circle.get denies an invited-but-not-active member', () => {
    expect(policy(HOST, 'circle.get', { membershipStatus: 'invited' })).toBe('deny');
  });
  it('circle.get denies a removed member', () => {
    expect(policy(HOST, 'circle.get', { membershipStatus: 'removed' })).toBe('deny');
  });
  it('circle.get denies a non-member', () => {
    expect(policy(HOST, 'circle.get', { membershipStatus: null })).toBe('deny');
  });

  it('circle.addMember allows the lead', () => {
    expect(policy(HOST, 'circle.addMember', { actorRole: 'lead' })).toBe('allow');
  });
  it('circle.addMember denies a plain member', () => {
    expect(policy(HOST, 'circle.addMember', { actorRole: 'member' })).toBe('deny');
  });

  it('circle.removeMember allows the lead removing someone else', () => {
    expect(policy(HOST, 'circle.removeMember', { actorRole: 'lead', targetIsSelf: false })).toBe(
      'allow',
    );
  });
  it('circle.removeMember allows a member removing themselves', () => {
    expect(policy(HOST, 'circle.removeMember', { actorRole: 'member', targetIsSelf: true })).toBe(
      'allow',
    );
  });
  it('circle.removeMember denies a plain member removing someone else', () => {
    expect(policy(HOST, 'circle.removeMember', { actorRole: 'member', targetIsSelf: false })).toBe(
      'deny',
    );
  });
  it('circle.removeMember denies a non-member "removing themselves"', () => {
    expect(policy(HOST, 'circle.removeMember', { actorRole: null, targetIsSelf: true })).toBe(
      'deny',
    );
  });

  it('circle.transferLead allows the current lead', () => {
    expect(policy(HOST, 'circle.transferLead', { actorRole: 'lead' })).toBe('allow');
  });
  it('circle.transferLead denies a plain member', () => {
    expect(policy(HOST, 'circle.transferLead', { actorRole: 'member' })).toBe('deny');
  });

  it('circle.acceptInvitation allows an invited user', () => {
    expect(policy(HOST, 'circle.acceptInvitation', { membershipStatus: 'invited' })).toBe('allow');
  });
  it('circle.acceptInvitation denies an already-active member', () => {
    expect(policy(HOST, 'circle.acceptInvitation', { membershipStatus: 'active' })).toBe('deny');
  });
  it('circle.acceptInvitation denies a removed member', () => {
    expect(policy(HOST, 'circle.acceptInvitation', { membershipStatus: 'removed' })).toBe('deny');
  });
  it('circle.acceptInvitation denies a user with no membership row', () => {
    expect(policy(HOST, 'circle.acceptInvitation', { membershipStatus: null })).toBe('deny');
  });
  it('circle.acceptInvitation denies an unauthenticated caller', () => {
    expect(policy(ANON, 'circle.acceptInvitation', { membershipStatus: 'invited' })).toBe('deny');
  });
});

describe('policy: plans', () => {
  it('plan.create allows a verified, good-standing host circle lead', () => {
    expect(policy(HOST, 'plan.create', { actorRole: 'lead' })).toBe('allow');
  });
  it('plan.create denies a non-lead host circle member', () => {
    expect(policy(HOST, 'plan.create', { actorRole: 'member' })).toBe('deny');
  });
  it('plan.create denies restricted standing even for the lead', () => {
    expect(policy(RESTRICTED, 'plan.create', { actorRole: 'lead' })).toBe('deny');
  });
  it('plan.create denies an unverified lead', () => {
    expect(policy(UNVERIFIED, 'plan.create', { actorRole: 'lead' })).toBe('deny');
  });

  it('plan.publish allows the lead', () => {
    expect(policy(HOST, 'plan.publish', { actorRole: 'lead' })).toBe('allow');
  });
  it('plan.publish denies a non-lead', () => {
    expect(policy(HOST, 'plan.publish', { actorRole: 'member' })).toBe('deny');
  });

  it('plan.get allows a published plan for any authenticated actor', () => {
    expect(policy(OTHER, 'plan.get', { published: true, actorHostsCircle: false })).toBe('allow');
  });
  it('plan.get allows an unpublished plan for the hosting circle', () => {
    expect(policy(HOST, 'plan.get', { published: false, actorHostsCircle: true })).toBe('allow');
  });
  it('plan.get denies an unpublished plan for an outsider', () => {
    expect(policy(OTHER, 'plan.get', { published: false, actorHostsCircle: false })).toBe('deny');
  });

  it('plan.update allows the lead', () => {
    expect(policy(HOST, 'plan.update', { actorRole: 'lead' })).toBe('allow');
  });
  it('plan.update denies a non-lead', () => {
    expect(policy(HOST, 'plan.update', { actorRole: 'member' })).toBe('deny');
  });

  it('plan.cancel allows the lead', () => {
    expect(policy(HOST, 'plan.cancel', { actorRole: 'lead' })).toBe('allow');
  });
  it('plan.cancel denies a non-lead', () => {
    expect(policy(HOST, 'plan.cancel', { actorRole: 'member' })).toBe('deny');
  });

  it('plan.close allows the lead', () => {
    expect(policy(HOST, 'plan.close', { actorRole: 'lead' })).toBe('allow');
  });
  it('plan.close denies a non-lead', () => {
    expect(policy(HOST, 'plan.close', { actorRole: 'member' })).toBe('deny');
  });
});

describe('policy: applications', () => {
  it('application.create allows a verified good-standing solo applicant', () => {
    expect(policy(HOST, 'application.create', { applyingAsCircle: false, actorRole: null })).toBe(
      'allow',
    );
  });
  it('application.create allows the lead of an applying circle', () => {
    expect(policy(HOST, 'application.create', { applyingAsCircle: true, actorRole: 'lead' })).toBe(
      'allow',
    );
  });
  it('application.create denies a non-lead member applying on behalf of a circle', () => {
    expect(
      policy(HOST, 'application.create', { applyingAsCircle: true, actorRole: 'member' }),
    ).toBe('deny');
  });
  it('application.create denies restricted standing', () => {
    expect(
      policy(RESTRICTED, 'application.create', { applyingAsCircle: false, actorRole: null }),
    ).toBe('deny');
  });
  it('application.create denies an unverified actor', () => {
    expect(
      policy(UNVERIFIED, 'application.create', { applyingAsCircle: false, actorRole: null }),
    ).toBe('deny');
  });

  it('application.confirm allows the confirming member in planned mode', () => {
    expect(
      policy(HOST, 'application.confirm', { planMode: 'planned', isConfirmingMember: true }),
    ).toBe('allow');
  });
  it('application.confirm denies a non-confirming-member actor', () => {
    expect(
      policy(HOST, 'application.confirm', { planMode: 'planned', isConfirmingMember: false }),
    ).toBe('deny');
  });

  it('application.delete allows the applicant circle lead', () => {
    expect(policy(HOST, 'application.delete', { actorRole: 'lead' })).toBe('allow');
  });
  it('application.delete denies a non-lead applicant member', () => {
    expect(policy(HOST, 'application.delete', { actorRole: 'member' })).toBe('deny');
  });

  it('application.withdrawMember allows the member themselves', () => {
    expect(policy(HOST, 'application.withdrawMember', { isSelfMember: true })).toBe('allow');
  });
  it('application.withdrawMember denies anyone else', () => {
    expect(policy(HOST, 'application.withdrawMember', { isSelfMember: false })).toBe('deny');
  });

  it('application.get allows an applicant member', () => {
    expect(policy(HOST, 'application.get', { isApplicantMember: true, isHostLead: false })).toBe(
      'allow',
    );
  });
  it('application.get allows the host circle lead', () => {
    expect(policy(HOST, 'application.get', { isApplicantMember: false, isHostLead: true })).toBe(
      'allow',
    );
  });
  it('application.get denies an outsider', () => {
    expect(policy(HOST, 'application.get', { isApplicantMember: false, isHostLead: false })).toBe(
      'deny',
    );
  });
});

describe('policy: review', () => {
  it('review.listApplications allows the host circle lead', () => {
    expect(policy(HOST, 'review.listApplications', { actorRole: 'lead' })).toBe('allow');
  });
  it('review.listApplications denies a non-lead', () => {
    expect(policy(HOST, 'review.listApplications', { actorRole: 'member' })).toBe('deny');
  });

  it('application.shortlist allows the host circle lead', () => {
    expect(policy(HOST, 'application.shortlist', { actorRole: 'lead' })).toBe('allow');
  });
  it('application.shortlist denies a non-lead', () => {
    expect(policy(HOST, 'application.shortlist', { actorRole: 'member' })).toBe('deny');
  });

  it('application.reject allows the host circle lead', () => {
    expect(policy(HOST, 'application.reject', { actorRole: 'lead' })).toBe('allow');
  });
  it('application.reject denies a non-lead', () => {
    expect(policy(HOST, 'application.reject', { actorRole: 'member' })).toBe('deny');
  });

  it('application.invite allows the host circle lead in planned mode', () => {
    expect(policy(HOST, 'application.invite', { planMode: 'planned', actorRole: 'lead' })).toBe(
      'allow',
    );
  });
  it('application.invite denies a non-lead even in planned mode', () => {
    expect(policy(HOST, 'application.invite', { planMode: 'planned', actorRole: 'member' })).toBe(
      'deny',
    );
  });
});

describe('policy: mode-scoped actions deny in the wrong mode', () => {
  it('application.confirm denies in tonight mode even for the confirming member', () => {
    expect(
      policy(HOST, 'application.confirm', { planMode: 'tonight', isConfirmingMember: true }),
    ).toBe('deny');
  });

  it('application.invite denies in tonight mode even for the host circle lead', () => {
    expect(policy(HOST, 'application.invite', { planMode: 'tonight', actorRole: 'lead' })).toBe(
      'deny',
    );
  });

  it('application.approve allows the host circle lead in tonight mode', () => {
    expect(policy(HOST, 'application.approve', { planMode: 'tonight', actorRole: 'lead' })).toBe(
      'allow',
    );
  });
  it('application.approve denies a non-lead even in tonight mode', () => {
    expect(policy(HOST, 'application.approve', { planMode: 'tonight', actorRole: 'member' })).toBe(
      'deny',
    );
  });
  it('application.approve denies in planned mode even for the host circle lead', () => {
    expect(policy(HOST, 'application.approve', { planMode: 'planned', actorRole: 'lead' })).toBe(
      'deny',
    );
  });

  it('invitation.accept allows the invitee in planned mode', () => {
    expect(policy(HOST, 'invitation.accept', { planMode: 'planned', isInvitee: true })).toBe(
      'allow',
    );
  });
  it('invitation.accept denies in tonight mode even for the invitee', () => {
    expect(policy(HOST, 'invitation.accept', { planMode: 'tonight', isInvitee: true })).toBe(
      'deny',
    );
  });

  it('invitation.decline allows the invitee in planned mode', () => {
    expect(policy(HOST, 'invitation.decline', { planMode: 'planned', isInvitee: true })).toBe(
      'allow',
    );
  });
  it('invitation.decline denies in tonight mode even for the invitee', () => {
    expect(policy(HOST, 'invitation.decline', { planMode: 'tonight', isInvitee: true })).toBe(
      'deny',
    );
  });

  it('MODE_SCOPED_ACTIONS names exactly the five mode-gated actions', () => {
    expect(new Set(MODE_SCOPED_ACTIONS)).toEqual(
      new Set([
        'application.confirm',
        'application.invite',
        'application.approve',
        'invitation.accept',
        'invitation.decline',
      ]),
    );
  });
});

describe('policy: messages -- gated on viability, not invitation (docs/modes.md overrides api.md here)', () => {
  it('message.getThread allows a circle member once the plan is viable', () => {
    expect(policy(HOST, 'message.getThread', { actorIsCircleMember: true, viable: true })).toBe(
      'allow',
    );
  });
  it('message.getThread denies a circle member before viability', () => {
    expect(policy(HOST, 'message.getThread', { actorIsCircleMember: true, viable: false })).toBe(
      'deny',
    );
  });
  it('message.getThread denies a non-member even on a viable plan', () => {
    expect(policy(HOST, 'message.getThread', { actorIsCircleMember: false, viable: true })).toBe(
      'deny',
    );
  });

  it('message.postThread allows a circle member once the plan is viable', () => {
    expect(policy(HOST, 'message.postThread', { actorIsCircleMember: true, viable: true })).toBe(
      'allow',
    );
  });
  it('message.postThread denies a circle member before viability', () => {
    expect(policy(HOST, 'message.postThread', { actorIsCircleMember: true, viable: false })).toBe(
      'deny',
    );
  });
});

describe('policy: safety', () => {
  it('safety.report allows an actor who shares a plan context with the subject', () => {
    expect(policy(HOST, 'safety.report', { sharesPlanContext: true })).toBe('allow');
  });
  it('safety.report denies an actor with no shared plan context', () => {
    expect(policy(HOST, 'safety.report', { sharesPlanContext: false })).toBe('deny');
  });

  it('safety.unblock allows the blocker', () => {
    expect(policy(HOST, 'safety.unblock', { isBlocker: true })).toBe('allow');
  });
  it('safety.unblock denies anyone else', () => {
    expect(policy(HOST, 'safety.unblock', { isBlocker: false })).toBe('deny');
  });

  it('safety.feedback allows an attendee', () => {
    expect(policy(HOST, 'safety.feedback', { isAttendee: true })).toBe('allow');
  });
  it('safety.feedback denies a non-attendee', () => {
    expect(policy(HOST, 'safety.feedback', { isAttendee: false })).toBe('deny');
  });
});

describe('policy: moderation -- resource.actorIsModerator is caller-supplied (see docs/state.md Known gaps)', () => {
  // Both outcomes are real at the rule level: the rule genuinely branches on
  // `actorIsModerator`. What is NOT proven here, and is recorded in
  // docs/state.md, is that any caller in this codebase can honestly produce
  // `actorIsModerator: true` today -- nothing does, because no moderator
  // credential exists (moderator capability is not an actor field until D4).
  it.each(['moderation.viewQueue', 'moderation.viewCase', 'moderation.act'] as const)(
    '%s allows when the caller-supplied moderator fact is true',
    (action) => {
      expect(policy(HOST, action, { actorIsModerator: true })).toBe('allow');
    },
  );

  it.each(['moderation.viewQueue', 'moderation.viewCase', 'moderation.act'] as const)(
    '%s denies a non-moderator',
    (action) => {
      expect(policy(HOST, action, { actorIsModerator: false })).toBe('deny');
    },
  );

  it('moderation.reviewAppeal allows a moderator who did not act on the case', () => {
    expect(
      policy(HOST, 'moderation.reviewAppeal', {
        actorIsModerator: true,
        actingModeratorId: OTHER.id,
      }),
    ).toBe('allow');
  });
  it('moderation.reviewAppeal denies the same moderator who acted', () => {
    expect(
      policy(HOST, 'moderation.reviewAppeal', {
        actorIsModerator: true,
        actingModeratorId: HOST.id,
      }),
    ).toBe('deny');
  });
  it('moderation.reviewAppeal denies a non-moderator regardless of who acted', () => {
    expect(
      policy(HOST, 'moderation.reviewAppeal', {
        actorIsModerator: false,
        actingModeratorId: OTHER.id,
      }),
    ).toBe('deny');
  });
});
