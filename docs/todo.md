# Unlisted — Roadmap

One milestone before any code. Then a build path that is shorter than the previous version, because the public-venue decision deleted most of it.

---

## Milestone 0 — Prove liquidity (no code)

The failure mode for this product is not a bad feature. It is a user opening the app on Thursday, seeing nothing to do on Saturday, and going back to their group chat — which is free, installed, and already contains their friends.

Two weekends. One district of one city. Instagram, WhatsApp, and a spreadsheet.

- [ ] Pick one district with venue density. Ankara or Istanbul.
- [ ] Recruit 20 circles willing to post a plan in the same week.
- [ ] Recruit 60 solo applicants.
- [ ] Collect plans and applications by form.
- [ ] Hand applications to the host circle lead and let them decide with no guidance.
- [ ] Assemble solo applicants into circles by hand. Note how long it takes and what breaks.
- [ ] Run both weekends. Attend. Watch the transitions, not the venue.
- [ ] Follow up with everyone within 48 hours.

**Numbers to leave with:**

| Metric | Why |
|---|---|
| Plans posted per circle per week | Whether supply is really the same population as demand |
| Fill rate | Whether posted plans reach their minimum |
| Host admission rate | Whether selection is real or an RSVP |
| Dyad rate | Plans confirming with two attendees. Must be zero |
| Tonight-mode share | How many plans are posted same-day, and whether they fill |
| Unattached arrival rate | Must be zero |
| Minimum size preference | Two-plus-two or three-plus-three |
| Signals and near-misses | Sets the on-call bar |

**Exit condition:** three or more plausible plans visible per user per weekend, and every number above written down from real nights.

---

## The branch

**Liquidity below three plans per user per weekend.** Do not build. Either narrow further — one venue, one recurring night — or stop. Nothing in the roadmap fixes an empty feed.

**Admission rate above ~60%.** Selection is not real. Rewrite as a distribution product and delete the review workspace.

**Plans rarely reach three.** The viability floor is throttling fill rather than protecting anyone, because nothing is confirming. Look at whether `open_spots` defaults are too low before touching `MIN_PLAN_TOTAL`, which does not move.

---

## Milestone 1 — Decide the rules

- [ ] Launch district, venue categories, permitted hours
- [ ] Verification vendor, evidence level, cost per applicant
- [ ] Graduated hosting ladder: what a new circle may post, what a record unlocks
- [ ] Published composition rules: permitted parameters and prohibited ones
- [ ] Record threshold before a host may post in tonight mode
- [ ] Withdrawal behaviour when a member drops a submitted application
- [ ] Cancellation, no-show, dispute, and appeal policy
- [ ] Business model: venue fees, subscription-for-eligibility, or both
- [ ] KVKK review of the data model and retention schedule with a specialist

**Exit condition:** every open decision in `product.md`, `safety.md`, and `security.md` has a written answer and a named owner.

---

## Milestone 2 — Foundation

- [ ] Auth: sign-up, sign-in, sign-out, recovery, server-side sessions with rotation
- [ ] Identity verification integration, webhook signature verification, `identity_hash`
- [ ] Schema per `data-model.md`, ULIDs throughout
- [ ] Repository layer with actor scoping; no unscoped queries outside admin tooling
- [ ] Single authorization module, deny by default
- [ ] State machines with transitions rejected rather than coerced
- [ ] Audit log on every state-changing action
- [ ] Image upload with server-side EXIF stripping, moderation, virus scan
- [ ] Transactional email and push with redacted bodies and delivery status
- [ ] Worker infrastructure for deadlines, retention, and pattern detection
- [ ] Synthetic seed data for development and staging

**Exit condition:** a test actor creates records, only authorized roles read or change them, and the deny path is tested for every endpoint.

---

## Milestone 3 — Safety and security floor

Ahead of the journeys. Nothing public ships before this.

- [ ] Verification enforced before posting or applying
- [ ] Bidirectional blocking applied in the query layer, tested mid-flight on a shared plan
- [ ] Report and feedback channels, including the morning-after prompt
- [ ] Signal model, pattern weighting, moderator queue, evidence view with per-access logging
- [ ] Silent enforcement filters in the repository scope
- [ ] Rate limits, bot detection, duplicate-identity checks
- [ ] Notification redaction verified on a locked phone screen
- [ ] Retention workers running and verified
- [ ] Escalation path and on-call rota with a named responsible person
- [ ] Security checklist in `security.md` completed
- [ ] External penetration test on the authorization layer

**Exit condition:** a realistic abuse case can be detected, acted on, and audited — before the first public plan, not after.

---

## Milestone 4 — Circles and plans

- [ ] Create a circle, invite members, transfer lead
- [ ] Venue registry with district and type
- [ ] Post a plan: venue, time, open spots, minimum, note
- [ ] Host circle member confirmation before publish
- [ ] Discovery feed filtered by district, date, blocks, and enforcement visibility
- [ ] Plan detail view with host circle record visible to applicants
- [ ] Edit, cancel, and complete a plan with the correct immutability rules

**Exit condition:** a circle posts a plan that appears in a stranger's feed with the right information and nothing more.

---

## Milestone 5 — Apply, review, attend

- [ ] Circle application with per-member confirmation bound to a version hash
- [ ] Solo application
- [ ] Review workspace: shortlist, reject, invite, whole circle or partial
- [ ] Partial invitation returning the affected circle to re-confirmation
- [ ] Capacity enforcement under a row lock; overlap rejection on accept
- [ ] Accept and decline, idempotent
- [ ] Circle-to-circle thread scoped to a plan, unlocked at invitation
- [ ] Plan card with confirmed group, transport, and the exit action
- [ ] Morning-after prompt
- [ ] Accessible empty, loading, error, expired, and success states

**Exit condition:** a solo applicant and a three-person circle each complete the real journey, and no path produces an unattached arrival.

---

## Milestone 6 — Tonight mode hardening

- [ ] Record threshold gating tonight-mode hosting
- [ ] Push-per-application delivery and latency
- [ ] Measure fill rate, signals, and dyad-cancellation rate against planned mode
- [ ] Decide whether tonight mode expands beyond the launch district

**Exit condition:** same-day plans fill at a usable rate without worse safety signals than planned plans.

---


## Milestone 7 — Expansion

- [ ] Second district, then second city
- [ ] Additional venue categories with category-specific rules
- [ ] Venue partnerships and the commercial relationship
- [ ] Recurring plans for circles that go out weekly
- [ ] Compare safety and attendance metrics against the launch district

---

## Continuous

- [ ] Keyboard, screen reader, contrast, responsive, reduced-motion
- [ ] Unit tests for state machines, capacity, minimum-group rules
- [ ] Integration tests for authorization allow and deny paths on every endpoint
- [ ] End-to-end tests for post, apply, assemble, review, invite, accept, decline, block, report
- [ ] Adversarial tests: IDOR, enumeration, capacity races, ban evasion, format-constraint attacks
- [ ] Performance budgets on the discovery feed
- [ ] Copy, community rules, and privacy disclosures kept current

---

## Deliberately not doing

- One-on-one plans, in any form
- Individual-to-individual messaging before an event
- Browsable people directory or user search
- Public ratings of individuals
- Payment for admission
- Private residences
- Weddings, university parties, bachelor and bachelorette parties
- Automated invitation

---

## First build slice

After Milestone 0 clears and Milestones 1–3 are done:

1. One district, one venue category
2. Three verified circles, one posting a plan
3. One circle application and one solo application
4. Real member confirmation bound to a version hash
5. Review, partial invitation, re-confirmation
6. Accept and decline under capacity
7. Circle-to-circle thread
8. Morning-after prompt and one signal flowing to the moderator queue

That slice exercises every invariant that makes this product different from a group chat. Nothing before Milestone 0 is worth writing.
