export const VERIFICATION_STATES = ['none', 'pending', 'verified', 'failed'] as const;
export const USER_STANDINGS = ['good', 'restricted', 'suspended', 'banned'] as const;

export type Ulid = string;
export type VerificationState = (typeof VERIFICATION_STATES)[number];
export type UserStanding = (typeof USER_STANDINGS)[number];

export interface UserActor {
  kind: 'user';
  id: Ulid;
  verificationState: VerificationState;
  standing: UserStanding;
}

export interface SystemActor {
  kind: 'system';
  label: string;
}

export type Actor = UserActor | SystemActor;

export const SYSTEM_ACTOR: SystemActor = Object.freeze({
  kind: 'system',
  label: 'system',
});
