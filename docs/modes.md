# Unlisted — Plan Modes

**This document is authoritative for anything mode-related.** Where it conflicts with `data-model.md` or `api.md`, this wins. Those files predate the two-mode design and will be reconciled later.

## Why two modes

People decide where to drink on Saturday on Thursday, or on Saturday. A single lifecycle cannot serve both: batch review with response deadlines is right for a plan four days out and absurd for one two hours out.

## The constants

```ts
MIN_HOST_CIRCLE         = 1     // one person can post a plan
MIN_APPLICANT_CIRCLE    = 1     // group application is convenience, not a gate
MIN_PLAN_TOTAL          = 3     // the only floor that matters. NEVER lower.

SPONTANEOUS_THRESHOLD_H = 24    // below this at publish, the plan is Tonight mode
RESPONSE_DEADLINE_MAX_H = 12
RESPONSE_DEADLINE_MIN_M = 15
RESPONSE_DEADLINE_RATIO = 0.25
```

With `MIN_HOST_CIRCLE = 1`, all structural protection rests on `MIN_PLAN_TOTAL`. At 2 the product is a dating app by definition — one host, one guest, at a bar, at night. Three is the smallest number that is not a dyad, and a third person is a witness. This constant is not a tuning parameter.

## Mode assignment

`mode` is derived at **publish** from `starts_at - now`, then stored and immutable.

- `starts_at - now >= SPONTANEOUS_THRESHOLD_H` → `planned`
- otherwise → `tonight`

A planned plan does not become a tonight plan as its start approaches. Response deadline compression, below, covers the late stages of a planned plan.

## Planned mode

Full lifecycle. Applications, review, formal invitation, applicant response.

```text
Application: Draft -> Awaiting confirmation -> Submitted
             -> Shortlisted -> Invited -> Accepted / Declined / Expired
                                 \
                                  -> Rejected
```

- Group applications require per-member confirmation bound to a version hash.
- Invitation places a **soft hold** on a spot, released when the invitation expires or is declined.
- Response deadline is computed at invitation time:

```ts
deadline = clamp(
  RESPONSE_DEADLINE_MIN_M,
  (starts_at - now) * RESPONSE_DEADLINE_RATIO,
  RESPONSE_DEADLINE_MAX_H
)
```

Never past `starts_at`.

## Tonight mode

No invitation entity. No response step. The host taps once and the applicant is in.

```text
Application: Submitted -> Approved / Rejected / Withdrawn / Expired
```

- Each application fires a push to the host. The host approves or rejects in place.
- Approval **hard-consumes** a spot immediately, under a row lock. There is no hold state.
- Group applications skip member confirmation. The lead's submission binds only the lead; other members apply as their own applications. Confirmation ceremony makes no sense at this timescale.
- An applicant may withdraw before `starts_at`. A withdrawal after approval records a late-decline signal.
- Applications expire at `starts_at`.

## Application closure

There is no cutoff constant. Applications close at the **earliest** of:

1. Accepted count reaches `open_spots`
2. Host closes applications manually
3. `starts_at`

This applies to both modes.

## The viability rule

The most important invariant in this document.

```
plan.viable  ⟺  confirmed_total >= MIN_PLAN_TOTAL
confirmed_total = confirmed host circle members + accepted guests
```

**Until a plan is viable:**

- No message thread exists. Not created-but-empty — not created.
- Guests see the venue, time, and the host's record. They do not see each other.
- The plan shows as pending on both sides.

**When a plan becomes viable:** the thread opens, participants become visible to each other, and the plan confirms.

**If a plan is not viable at `starts_at`:** it auto-cancels. Everyone is notified that it did not come together. Nobody is told who else had applied or accepted.

This is what makes `MIN_HOST_CIRCLE = 1` safe. A host and a single accepted guest are never introduced to each other, never share a channel, and never receive a confirmed plan. The dyad cannot be reached through any sequence of actions, because viability gates the introduction rather than the acceptance.

## Schema deltas

Against `data-model.md`:

**Plan**

| Field | Note |
|---|---|
| `mode` | `planned` \| `tonight`. Set at publish, immutable |
| `viable_at` | Timestamp when viability was first reached. Null until then |
| `applications_closed_at` | Set by any of the three closure conditions |

**Application**

| Field | Note |
|---|---|
| `mode` | Denormalised from the plan. Determines the valid state set |
| `response_deadline` | Planned mode only. Null in tonight mode |

`Assembly` is **not built**. The table, endpoints, and worker are deferred. With `MIN_PLAN_TOTAL = 3` the arrival rule is satisfied by the viability gate, so grouping solo applicants beforehand is an optimisation rather than a requirement.

**MessageThread** gains a hard rule: a thread row may only be created for a plan where `viable_at IS NOT NULL`. Enforce as a check constraint or a trigger, not only in application code.

## API deltas

Against `api.md`:

| Endpoint | Change |
|---|---|
| `POST /plans/:id/publish` | Computes and stores `mode` |
| `POST /applications/:id/confirm` | Planned mode only. 404 in tonight mode |
| `POST /applications/:id/invite` | Planned mode only |
| `POST /applications/:id/approve` | **New.** Tonight mode only. Hard-consumes a spot under a row lock. Idempotent |
| `POST /invitations/:id/accept` | Planned mode only |
| `GET /plans/:id/thread` | 404 until `viable_at IS NOT NULL` |
| `POST /plans/:id/close` | **New.** Host closes applications manually |

Assembly endpoints are not implemented.

## Safety under Tonight mode

Stated plainly, because it is a real reduction: **tonight mode removes review time.** A host approving in fifteen seconds from a push notification is not vetting anyone.

What carries the weight instead:

- **The public venue.** Unchanged and still the largest control.
- **The three-person floor and the viability gate.** No dyad is ever introduced, in either mode.
- **The host's visible record.** Applicants see plans run and whether guests returned, and this matters more here because it is the only signal available before deciding to go.
- **Verification.** Traceability and ban durability are unaffected by timescale.
- **Post-event signals.** Non-return and morning-after feedback work identically.

What does **not** carry weight in tonight mode: the review workspace, shortlisting, and considered selection. Do not build UI or copy implying that tonight-mode guests were vetted.

Restriction to apply from launch: **tonight mode is unavailable to host circles below a minimum record threshold.** A brand-new account cannot post a same-night plan. Threshold to be set once there is data — until then, gate tonight mode behind at least one completed plan as a host or guest.

## Test requirements

- A plan reaching exactly two confirmed attendees never produces a thread, never confirms, and auto-cancels at start.
- Tonight-mode approval under concurrent requests at the last spot: exactly one succeeds.
- Confirm, invite, and accept endpoints all 404 in tonight mode.
- Approve 404s in planned mode.
- Response deadline never exceeds `starts_at` and never falls below the floor.
- Mode is immutable after publish.
