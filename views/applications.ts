import type { ApplicationRecord } from '@/db/repositories/applications';

/**
 * Application view models (C5 / C6).
 *
 * `ApplicationView` — `GET /applications/:id`. One shape for both audiences the
 * endpoint serves (applicant members, or the host circle lead): the applicant
 * authored the note and knows their own member set; the host needs exactly the
 * note + member set + confirmation states to review. Neither audience learns
 * anything about other applications or other applicants (§3), and a rejected
 * application carries no reason — there is no reason field anywhere. F1 forks
 * this into applicant-self vs host-contextual if a real divergence appears.
 *
 * `ApplicationReviewView` — one row of `GET /plans/:id/applications` (host
 * circle lead only). Group context is preserved: `members` stays a nested
 * array, never flattened into sibling rows.
 *
 * Raw plan attendance counts never appear here; capacity lives on `PlanView`.
 */

export interface ApplicationMemberView {
  userId: string;
  confirmationState: 'unconfirmed' | 'confirmed';
  invitationState: 'not_invited' | 'invited' | 'accepted' | 'declined' | 'expired';
}

export interface ApplicationView {
  id: string;
  planId: string;
  mode: 'planned' | 'tonight';
  state: ApplicationRecord['state'];
  applicantKind: 'circle' | 'solo';
  applicantCircleId: string | null;
  soloUserId: string | null;
  note: string | null;
  members: ApplicationMemberView[];
  responseDeadline: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
}

function toMemberView(m: ApplicationRecord['members'][number]): ApplicationMemberView {
  return {
    userId: m.userId,
    confirmationState: m.confirmationState,
    invitationState: m.invitationState,
  };
}

export function toApplicationView(a: ApplicationRecord): ApplicationView {
  return {
    id: a.id,
    planId: a.planId,
    mode: a.mode,
    state: a.state,
    applicantKind: a.applicantCircleId !== null ? 'circle' : 'solo',
    applicantCircleId: a.applicantCircleId,
    soloUserId: a.soloUserId,
    note: a.note,
    members: a.members.map(toMemberView),
    responseDeadline: a.responseDeadline?.toISOString() ?? null,
    submittedAt: a.submittedAt?.toISOString() ?? null,
    decidedAt: a.decidedAt?.toISOString() ?? null,
  };
}

export interface ApplicationReviewView {
  id: string;
  applicantKind: 'circle' | 'solo';
  applicantCircleId: string | null;
  soloUserId: string | null;
  state: ApplicationRecord['state'];
  note: string | null;
  members: ApplicationMemberView[];
  submittedAt: string | null;
}

export function toApplicationReviewView(a: ApplicationRecord): ApplicationReviewView {
  return {
    id: a.id,
    applicantKind: a.applicantCircleId !== null ? 'circle' : 'solo',
    applicantCircleId: a.applicantCircleId,
    soloUserId: a.soloUserId,
    state: a.state,
    note: a.note,
    members: a.members.map(toMemberView),
    submittedAt: a.submittedAt?.toISOString() ?? null,
  };
}
