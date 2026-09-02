# Unlisted — Product Definition

## One line

A circle of friends posts a plan at a public venue with open spots; other circles and solo applicants apply; the posting circle decides who joins.

## The bet

Every adjacent product matches individuals. Dating apps match pairs. Curated-stranger platforms assign individuals to tables. Invitation tools give hosts approval controls but no applicants to approve.

Nobody lets a group choose a group. That is the whole product, and it produces three things at once:

- **Supply solves itself.** Any user can post a plan, so supply and demand are the same population. There is no scarce host class, which was the fatal constraint in every earlier version of this idea.
- **Retention is weekly.** Going out with friends recurs. A wedding does not.
- **Safety is structural.** Nobody arrives alone, because the arrival unit is a group.

## The defining rule

**No plan ever becomes a meeting between two people.**

This replaces the earlier "you cannot attend alone" formulation, which required grouping solo applicants before the night and throttled liquidity badly.

Anyone can post a plan — one person, no pre-committed friends. Anyone can apply alone. What is guaranteed instead is the **viability rule**:

```
plan.viable  ⟺  confirmed host members + accepted guests >= MIN_PLAN_TOTAL (3)
```

Until a plan is viable, no thread exists, guests are not visible to each other, and the plan is not confirmed. A plan still non-viable at its start time auto-cancels and reveals nobody.

So a host and a single accepted guest are never introduced, never share a channel, and never receive a confirmed plan. The dyad is unreachable through any sequence of actions — not because acceptance is blocked, but because introduction is gated.

Assembly is deferred. With a three-person floor and the viability gate, pre-grouping solo applicants is an optimisation rather than a requirement. See `modes.md`.

## Format constraints, enforced server-side

These are invariants, not guidelines. They are what makes "not a dating app" a fact about the architecture rather than a claim in the copy.

- No plan with fewer than the configured minimum on either side.
- No direct messaging between individuals before an event. Communication is circle-to-circle, scoped to a plan, and visible to both circles.
- No browsable directory of people. A person is visible only in the context of a plan they have applied to or been invited to.
- No contact by default after an event, unless both sides opt in.
- Venues must be registered public facilities with an operator.

Romantic outcomes between people who meet at a plan are not prevented, policed, or designed against. The format is one-to-many-groups; what happens off-platform afterwards is not our business.

## The constants

```ts
MIN_HOST_CIRCLE      = 1   // one person can post a plan
MIN_APPLICANT_CIRCLE = 1   // group application is convenience, not a gate
MIN_PLAN_TOTAL       = 3   // structural. not a tuning parameter.
```

With `MIN_HOST_CIRCLE = 1`, all structural protection rests on `MIN_PLAN_TOTAL`. At 2 the product is a dating app by definition — one host, one guest, at a bar, at night. Three is the smallest number that is not a dyad, and a third person is a witness.

The first two are conveniences and can move. The third cannot.

## Users

**Circle members.** People who go out with a recurring group of friends. A circle is persistent, has a lead, and applies as a unit.

**Circle leads.** Post plans, submit applications, and decide on applicants for plans their circle hosts. They cannot act on a member's behalf without that member's confirmation.

**Solo applicants.** Apply alone. Protected by the viability rule rather than by pre-grouping.

**Venues.** Registered public facilities. They are infrastructure, not hosts. They may be verified partners with a commercial relationship, but they never select guests — a venue's interest is maximum footfall, which would drive admission rate to nearly everyone and turn this into a distribution product.

**Trust and safety operators.** Verification, signals, enforcement, appeals, incident response.

## Language

- **Circle** — a persistent group of people who go out together. Has a lead and members.
- **Plan** — a concrete outing at a venue: place, date, time, open spots. Posted by a host circle.
- **Application** — a request to join a plan, from a circle or a solo applicant. Not a reservation.
- **Confirmation** — a circle member's consent to be included in an application.
- **Invitation** — a formal offer from the host circle after review.
- **Acceptance** — an invited applicant's commitment to attend.
- **Viability** — a plan having reached `MIN_PLAN_TOTAL` confirmed attendees. Gates the thread and mutual visibility.
- **Signal** — any observation that feeds enforcement. Reports are one kind.

## Two modes

Plans posted more than 24 hours out run in **planned** mode: applications, review, formal invitation, applicant response. Plans posted for the same evening run in **tonight** mode: the host gets a push per application and taps once to admit, with no invitation ceremony.

Mode is set at publish and immutable. Applications close at the earliest of spots filled, host closes, or start time — there is no fixed cutoff. Full specification in `modes.md`.

Tonight mode removes review time and should not be described as vetted. What carries the weight there is the public venue, the viability floor, the host's visible record, and verification.

## Core journeys

### Post a plan

1. A user picks a venue from the registry and sets date, time, and open spots. They may bring circle members, or post alone.
2. Optional short note on the vibe of the night.
3. Any included circle members confirm they are attending.
4. The plan publishes, receives its mode, and becomes discoverable in its district.

### Apply

1. A user browses plans by district, date, venue type, and open spots.
2. They apply as a group or alone.
3. In planned mode, every included member confirms the exact submitted version.
4. In tonight mode there is no confirmation step; each person applies for themselves.
5. The application reaches the host.

### Review and invite

1. The host circle lead sees applications, each with member profiles and shared context.
2. They reject, shortlist, or invite the whole applicant circle or selected members.
3. Partial invitations require re-confirmation from the affected circle.
4. Capacity reflects invitations and acceptances; overbooking is impossible.
5. All decisions are timestamped.

### Attend

1. Invitees accept or decline before a deadline.
2. Accepted guests get venue details, arrival time, and the confirmed group.
3. The plan card includes transport options and, for late plans, an exit route.
4. The morning after, everyone gets one question.

## Lifecycle

```text
Plan:                 Draft -> Published -> Applications closed -> Completed / Cancelled
                                                               \-> Cancelled (non-viable at start)

Application (planned): Draft -> Awaiting confirmation -> Submitted
                       -> Shortlisted / Rejected -> Invited -> Accepted / Declined / Expired

Application (tonight): Submitted -> Approved / Rejected / Withdrawn / Expired
```

Every transition is timestamped and auditable. A circle may hold members in different states after a partial invitation. Viability is recomputed on every change to attendance.

## Capabilities

**Profiles.** Verified age and identity status, first name, one or two photos, short written context. Platform-generated record: plans attended, no-shows, late declines, repeat invitations, standing. Not editable by the user. Photos are for recognition at the venue, not evaluation, and are never the first thing a reviewer sees.

**Circles.** Stable identity, lead, members, shared history. A circle accrues its own record.

**Plans.** Venue, district, date, time, open spots, minimum group size, note. No hidden location — the venue is public.

**Review workspace.** New, shortlisted, invited, accepted, declined, rejected, expired. Circle context preserved. Notes, capacity tracking, decision history.

**Trust and safety.** See `safety.md`.

## Measures

### Decisive

- **Liquidity density** — plans visible to a user in their district for the coming weekend. Below three, the product is empty and users return to their group chat.
- **Fill rate** — published plans that reach their minimum.
- **Host admission rate** — if host circles admit nearly everyone, selection is not real and this is a distribution product.
- **Dyad rate** — plans that confirmed with two attendees. Must be zero. Any non-zero value is an architecture failure.

### Health

- Share of plans posted in tonight mode, and their fill rate against planned mode
- Circle confirmation completion rate
- Repeat plan posting per circle per month
- Repeat attendance, especially by women, as the clearest revealed-preference signal
- Signals per 100 attendees
- Post-event response rate — a falling rate means the report channel is dying

## Out of scope

- One-on-one plans, in any form
- Individual-to-individual messaging before an event
- Browsable people directory
- Public ratings of individuals
- Payment for admission
- Private residences
- Weddings, university parties, bachelor and bachelorette parties
- Any automated invitation

## Open decisions

- Record threshold before a host may post in tonight mode
- Business model: venue fees, subscription-for-eligibility, or both
- Verification vendor and cost per applicant against a funnel where most never attend
- Whether circles can hold competing applications for the same night
- Standing rules: what a circle's record unlocks or restricts
