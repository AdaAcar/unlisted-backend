# Unlisted — Data Model

## Conventions

- **Identifiers are ULIDs**, never sequential integers. Sequential IDs allow enumeration of every plan and profile on the platform with a loop.
- **Timestamps everywhere.** `created_at`, `updated_at`, and an explicit transition log for anything with a state.
- **Soft delete for records under retention obligation** (`deleted_at`), hard delete for user-requested erasure of personal data. These are different operations and must not share a code path.
- **Sensitivity is annotated per field.** `public` visible to any authenticated user, `contextual` visible only within a shared plan, `internal` never leaves the server, `restricted` encrypted at rest with separate access control.

---

## User

| Field | Sensitivity | Note |
|---|---|---|
| `id` | public | ULID |
| `first_name` | public | Display name; no surname on the platform |
| `photos[]` | contextual | 1–2, EXIF stripped on upload |
| `bio` | contextual | Short free text, moderated |
| `age` | public | Derived from verified DOB, never the DOB itself |
| `district` | public | Approximate only |
| `verification_state` | public | `none` \| `pending` \| `verified` \| `failed` |
| `verification_ref` | restricted | Vendor reference. The document is never stored by us |
| `identity_hash` | restricted | Stable hash of verified identity, for ban durability |
| `standing` | internal | `good` \| `restricted` \| `suspended` \| `banned` |
| `signal_score` | internal | Never exposed, never shown to any user |
| `created_at` | internal | |

The date of birth is not stored. The verification vendor asserts 18+ and returns an age; we keep the age.

`identity_hash` exists so that a ban attaches to a person rather than an account. It must not be reversible to the underlying document.

## Record

Platform-generated, not user-editable. This is the profile layer that actually matters.

| Field | Sensitivity |
|---|---|
| `user_id` | internal |
| `plans_attended` | contextual |
| `no_shows` | contextual |
| `late_declines` | contextual |
| `repeat_invitations` | contextual |
| `circles_led` | contextual |
| `first_plan_at` | contextual |

Visible to a host circle lead reviewing an application. Not visible in any browse context, because there is no browse context for people.

## Circle

| Field | Sensitivity | Note |
|---|---|---|
| `id` | public | |
| `name` | contextual | User-chosen |
| `lead_user_id` | internal | |
| `member_ids[]` | contextual | |
| `record` | contextual | Circle-level attendance and reliability |
| `created_at` | internal | |

A circle is persistent and accrues its own record. Membership changes are logged.

## Venue

| Field | Sensitivity | Note |
|---|---|---|
| `id` | public | |
| `name`, `address`, `district` | public | Public facility — no secrecy layer |
| `type` | public | bar, restaurant, club, beach, café |
| `operator_verified` | public | Whether we have a relationship with the operator |
| `licence_ref` | internal | Where applicable |
| `capacity_hint` | internal | |

The absence of an address-protection subsystem is the single largest simplification of this model versus earlier versions. Do not reintroduce it.

## Plan

| Field | Sensitivity | Note |
|---|---|---|
| `id` | public | |
| `host_circle_id` | public | |
| `venue_id` | public | |
| `starts_at`, `ends_at` | public | |
| `open_spots` | public | |
| `min_group_size` | public | Applicant-side minimum |
| `note` | public | Short free text, moderated |
| `state` | public | See machine below |
| `district` | public | Denormalised from venue for discovery |

### Plan states

```text
Draft -> Published -> Applications closed -> Completed
   \                        \
    -> Cancelled             -> Cancelled
```

Invariants:

- Cannot publish below `MIN_HOST_CIRCLE` confirmed host-circle members.
- `open_spots` plus host circle size must be at least `MIN_PLAN_TOTAL`.
- Cannot publish with `starts_at` in the past or beyond the configured horizon.
- Applications close automatically at the configured cutoff before `starts_at`.

## Application

| Field | Sensitivity | Note |
|---|---|---|
| `id` | internal | |
| `plan_id` | internal | |
| `applicant_circle_id` | internal | Null for an unassembled solo applicant |
| `solo_user_id` | internal | Null for a circle application |
| `member_states[]` | internal | Per-member confirmation and invitation state |
| `note` | contextual | Shared context written by the lead |
| `state` | internal | See machine below |

### Application states

```text
Draft -> Awaiting confirmation -> Submitted -> Shortlisted -> Invited
                                     |            |             |
                                     v            v             v
                                  Rejected     Rejected    Accepted / Declined / Expired
```

Invariants:

- Cannot leave `Awaiting confirmation` while any included member is unconfirmed.
- A partial invitation re-enters `Awaiting confirmation` for the affected circle. Nobody is invited into a smaller group than they agreed to without re-consenting.
- A member who withdraws after submission drops the application below its minimum, which either invalidates it or triggers re-confirmation, depending on configuration. Decide this explicitly.
- Accepting cannot push `accepted_count` above `open_spots`. Enforced with a lock on the plan row.
- A user cannot hold two accepted invitations for overlapping windows.

## Assembly

The mechanism that lets solo applicants exist without breaking the arrival rule.

| Field | Sensitivity |
|---|---|
| `id` | internal |
| `plan_id` | internal |
| `pool_user_ids[]` | internal |
| `proposed_circle_ids[]` | internal |
| `state` | internal |

```text
Pool -> Proposed -> Confirmed -> Attached to plan
           \
            -> Dissolved
```

Every proposed member must confirm before the assembly attaches. An assembly that does not reach the minimum by the cutoff dissolves, and its members are notified that the plan did not work out — never that specific people declined.

## Message thread

| Field | Sensitivity | Note |
|---|---|---|
| `id` | internal | |
| `plan_id` | internal | Always scoped to a plan |
| `circle_a_id`, `circle_b_id` | internal | Both required |
| `participants[]` | internal | All members of both circles |

**Hard invariant: a thread must have exactly two circle IDs and at least `MIN_PLAN_TOTAL` participants.** A thread between two individuals cannot be represented in this schema, which is deliberate — the constraint is structural rather than enforced by a check that could be forgotten.

## Signal

Everything that feeds enforcement. A report is one kind of signal; most signals are softer.

| Field | Sensitivity | Note |
|---|---|---|
| `id` | internal | |
| `subject_user_id` | internal | |
| `reporter_user_id` | internal | Null for platform-generated signals |
| `plan_id` | internal | |
| `kind` | internal | report, non-return, early-departure, low-response, no-show |
| `weight` | internal | |
| `created_at` | internal | |

Signals are never exposed to any user, including the subject. See `safety.md` for how patterns become actions.

## Block

| Field | Sensitivity |
|---|---|
| `blocker_user_id` | internal |
| `blocked_user_id` | internal |

Applied as a bidirectional filter in the repository layer. Neither party sees the other's plans, applications, or profile, and neither is informed. A block implemented in the UI only is not a block.

## Audit log

Append-only. Every state-changing action by any actor, and every moderator action without exception.

| Field |
|---|
| `actor_id`, `actor_role` |
| `action`, `resource_type`, `resource_id` |
| `before_state`, `after_state` |
| `ip_hash`, `user_agent_hash` |
| `created_at` |

Moderator actions are audited more heavily than user actions, because insider access is the most likely path to a serious privacy failure and the least likely to be noticed.

## Retention

| Data | Retention |
|---|---|
| Verification artefacts | Vendor reference only; document never stored by us |
| Signals | Expire on a schedule unless part of an active case |
| Message threads | Deleted a fixed period after the plan completes |
| Audit log | Long retention, restricted access |
| Deleted account | Personal fields erased; `identity_hash` retained if banned, so the ban survives |

The last row is a deliberate tension between erasure rights and ban durability. Document the legal basis before launch rather than discovering it during a complaint.
