# todo_claude.md

Backend build order for Claude Code. Read `CLAUDE.md` first.

**Read `docs/modes.md` before any task in Phase A or C.** It is authoritative for the plan and application lifecycle and supersedes `data-model.md` and `api.md` where they conflict.

**One task per session.** Each task lists what to read, what done means, and what not to do. Do not start a task without being asked. Do not skip ahead — later tasks assume earlier ones.

The final phase produces the API contract the UI will be built against. Everything before it exists to make that contract correct.

---

## Phase A — Foundations

### A1. Bootstrap

**Read:** `docs/architecture.md`

Next.js App Router, TypeScript strict, Drizzle, Postgres, Vitest. Create the folder structure from `CLAUDE.md` section 4 with a placeholder in each. Add `lib/config.ts` with the values from section 5. Set up lint, format, and test scripts.

**Done when:** `pnpm dev`, `pnpm lint`, and `pnpm test` all run clean on an empty project.

**Do not:** add UI, styling, component libraries, or any dependency beyond the pinned stack.

---

### A2. Schema and migrations

**Read:** `docs/data-model.md` in full, then `docs/modes.md` schema deltas

Drizzle schema for every entity: User, Record, Circle, CircleMember, Venue, Plan, Application, ApplicationMember, MessageThread, Message, Signal, Block, AuditLog.

**No Assembly table.** Assembly is deferred.

Requirements:

- ULID primary keys throughout.
- `Plan` carries `mode`, `viable_at`, `applications_closed_at` per `docs/modes.md`.
- `Application` carries `mode` and a nullable `response_deadline`.
- `MessageThread` has two non-null circle FKs **and** a database-level check that the referenced plan has `viable_at IS NOT NULL`. A thread on a non-viable plan must be impossible to insert, not merely rejected in code.
- `identity_hash` and `verification_ref` on separate columns, marked for encryption at rest.
- No `date_of_birth` column anywhere. `age` only.
- Database-level constraints wherever an invariant is expressible: capacity non-negative, minimum sizes, valid state enums.
- Indexes for the discovery query: plans by district and start time and state.

**Done when:** migrations apply cleanly, a test proves a thread cannot be inserted for a non-viable plan, and a test proves a two-person-thread case cannot be inserted.

**Do not:** write repositories or queries yet.

---

### A3. Repository layer

**Read:** `docs/architecture.md` trust boundaries, `docs/security.md` layer: data

Every repository function takes an `actor` as its first argument and scopes the query to what that actor may see. Block filters and enforcement visibility filters are applied **inside the query**, not after fetching.

No unscoped `findMany` exists outside an explicitly named admin module.

**Done when:** a test proves a blocked user's plans do not appear in another user's feed query, and that the exclusion happens in SQL rather than in application code.

---

### A4. Audit log

**Read:** `docs/data-model.md` audit log

Append-only write path. Every state-changing operation records actor, action, resource, before state, after state, hashed IP and user agent, timestamp. Moderator actions record a reason string.

Wire it as a helper the domain layer calls, not as middleware — middleware misses transactional context.

**Done when:** an audited action inside a rolled-back transaction leaves no audit row, and a committed one leaves exactly one.

---

### A5. Policy module

**Read:** `docs/api.md` in full, `docs/architecture.md` authorization model

`policy(actor, action, resource) → allow | deny`. Deny by default. Actor carries id, verification state, standing, and visibility filters.

Write the full rule table from `docs/api.md` as data, not as a chain of conditionals, so it can be tested exhaustively and read as a spec.

**Done when:** every action named in `docs/api.md` has a rule, and tests cover both outcomes for each. Missing rules fail the test suite.

**Do not:** implement any endpoint yet.

---

### A6. State machines

**Read:** `docs/modes.md` in full, `docs/data-model.md` state sections

Pure functions, no database imports. Plan machine, plus **two** application machines — planned and tonight. No Assembly machine.

Encode: publish feasibility (`host size + open_spots >= MIN_PLAN_TOTAL`); the viability predicate; the three application-closure conditions; response deadline computation with clamping; mode immutability after publish.

Planned only: member confirmation bound to a version hash, voided when the application changes; partial invitation returning the circle to awaiting-confirmation; invitation soft hold.

Tonight only: direct approve with hard spot consumption; no invitation or confirmation states.

**Done when:** exhaustive tests over every state-action pair per mode, including every invalid one, plus a test that no action sequence in either mode produces a viable plan with fewer than `MIN_PLAN_TOTAL` attendees.

---

## Phase B — Identity

### B1. Auth

**Read:** `docs/api.md` auth, `docs/security.md` layer: API

Server-side sessions, httpOnly, `SameSite=Lax`, rotation on privilege change, individual revocation. Generic failure messages. Recovery always returns success regardless of whether the account exists.

**Done when:** session fixation, enumeration via error text, and stale-session-after-privilege-change are each covered by a test.

---

### B2. Verification

**Read:** `docs/api.md` verification, `docs/security.md` compliance

Vendor-agnostic interface with a stub implementation behind a feature flag, so the real vendor drops in later without touching callers. The webhook verifies its signature before parsing the body. Stores `verification_state`, `age`, `identity_hash`. Never stores a document.

**Done when:** an unsigned webhook is rejected before parsing, and `identity_hash` collision blocks a second account.

**Do not:** integrate a paid vendor. The stub is correct for now.

---

## Phase C — Core loop

### C1. Circles

**Read:** `docs/api.md` circles

Create, invite member, member accepts, remove member, transfer lead. Circle record fields updated by the domain layer only.

**Done when:** a non-member gets 404 on every circle route, and lead-only actions are denied to members.

---

### C2. Venues

**Read:** `docs/data-model.md` venue

Registry with district and type filters. `licence_ref` and `capacity_hint` never appear in any view model.

**Done when:** a view model test asserts the internal fields are absent from the serialized output.

---

### C3. Plans

**Read:** `docs/api.md` plans, `docs/product.md` core journeys

Create draft, publish, edit with immutability after the first invitation or approval, cancel, complete, and manual close of applications.

Publish computes and stores `mode` from `starts_at - now` against `SPONTANEOUS_THRESHOLD_H`, and enforces `host size + open_spots >= MIN_PLAN_TOTAL`.

**Done when:** an infeasible plan cannot publish, `mode` is immutable after publish, and venue and time are immutable once anyone has been invited or approved.

---

### C4. Discovery

**Read:** `docs/api.md` plans, `docs/security.md` enumeration

Feed filtered by district, date, venue type, and open spots. Block and enforcement filters applied in SQL. Rate limited hard.

**Done when:** a test proves excluded plans never enter application memory, and pagination cannot be used to enumerate the full plan set.

---

### C5. Applications

**Read:** `docs/api.md` applications, `docs/modes.md`

Planned mode: group application with per-member confirmation bound to a version hash; solo application; submission blocked while any member is unconfirmed.

Tonight mode: solo applications only in effect — a group lead's submission binds only the lead, and other members apply individually. No confirmation step. `POST /applications/:id/confirm` returns 404.

Withdrawal handling in both modes.

**Done when:** editing a planned application after partial confirmation voids prior confirmations, and confirm 404s in tonight mode — both proven by test.

---

### C6. Review

**Read:** `docs/api.md` review, `docs/modes.md`

Planned mode only. In tonight mode there is no shortlist or invitation step — see C7b.

Host sees applications with group context preserved. Shortlist, reject, invite whole circle or selected members. Partial invitation returns the affected circle to awaiting-confirmation. Rejection returns a neutral outcome with no reason to the applicant.

**Done when:** a partial invitation cannot complete without re-confirmation from every affected member.

---

### C7a. Invitations and capacity — planned mode

**Read:** `docs/api.md` invitations, `docs/modes.md`, `docs/architecture.md` concurrency

Invitation places a soft hold on a spot, released on decline or expiry. Response deadline computed with the clamp formula and never past `starts_at`. Accept and decline both idempotent. Accept takes a row lock on the plan inside a transaction. Rejects on capacity overflow and on overlap with another accepted plan.

**Done when:** concurrent accepts at the last remaining spot leave exactly one winner, and an expired hold returns the spot to the pool.

---

### C7b. Approve — tonight mode

**Read:** `docs/modes.md`

`POST /applications/:id/approve`. Host taps once; the applicant is in. Hard-consumes a spot under a row lock. Idempotent. No invitation row, no response step. 404 in planned mode, and the planned-mode endpoints 404 here.

Gate: tonight mode is unavailable to hosts below the record threshold in `docs/modes.md`.

**Done when:** concurrent approvals at the last spot leave exactly one winner, and every planned-mode endpoint 404s on a tonight plan.

---

### C7c. Viability

**Read:** `docs/modes.md` viability rule

Recompute viability on every acceptance, approval, withdrawal, and host-member change. Set `viable_at` on first crossing. Opening the thread and making participants visible to each other are consequences of viability, never of acceptance.

A plan still non-viable at `starts_at` auto-cancels, notifying everyone that it did not come together, revealing nobody.

**Done when:** a plan that reaches exactly two confirmed attendees never produces a thread, never confirms, never reveals participants to each other, and auto-cancels — proven by an adversarial test that attempts to reach the dyad through every available action sequence.

---

### C8. Threads

**Read:** `docs/api.md` messages

Thread scoped to a plan, created **on viability**, never on invitation or approval. Participants are all confirmed attendees.

**Done when:** no route, parameter combination, or direct repository call can produce a thread on a non-viable plan.

---

## Phase D — Safety

Nothing goes public before this phase completes.

### D1. Blocks

**Read:** `docs/safety.md`, `docs/security.md` stalking

Bidirectional, applied in the query layer, neither party notified. A block placed while a shared plan is in flight removes the parties from each other's view of it.

**Done when:** the mid-flight case has an explicit passing test.

---

### D2. Signals and reports

**Read:** `docs/safety.md` reporting and escalation, `docs/data-model.md` signal

Report endpoint. Platform-generated signals: no-show, early departure, non-return, low feedback. Weighting. Subject never notified. Reporter never surfaced.

**Done when:** signals are absent from every view model, including the subject's own profile response.

---

### D3. Feedback

**Read:** `docs/safety.md` ambient controls

Morning-after prompt: one per attendee per plan, behaviourally specific, private. Feeds the signal model.

---

### D4. Moderation

**Read:** `docs/api.md` moderation

Queue grouped by subject and ordered by pattern weight. Evidence view with per-access logging including a stated reason. Actions require a written reason. Appeals routed to a different moderator than the one who acted.

**Done when:** every moderator read produces an audit entry with a reason.

---

### D5. Rate limits and abuse

**Read:** `docs/api.md` rate limits

Per account and per IP. Duplicate identity detection at verification. Report limits set high enough that no honest user reaches them.

---

## Phase E — Workers

### E1. Scheduled jobs

Invitation and hold expiry. Application closure at `starts_at`. Auto-cancel of non-viable plans at `starts_at`, notifying everyone that the plan did not come together and revealing nobody.

### E2. Retention

Per the schedule in `docs/data-model.md`. Message threads deleted after a fixed period. Signals expire unless part of an active case. Account erasure removes personal fields while retaining `identity_hash` for banned users.

**Stop and ask** before implementing the erasure-versus-ban behaviour. It is an open legal question.

### E3. Notifications

Transactional email and push with redacted bodies. Delivery status and retry. A notification body must never contain venue, time, or attendee names.

---

## Phase F — Handoff to the UI

This phase exists so the interface can be built without reading the backend.

### F1. View models

Every response passes through an explicit view model. One per audience per entity — public, contextual, self, moderator. Adding a field to an entity must not change any response without a deliberate view model edit.

**Done when:** a test asserts that no route returns a raw domain entity.

---

### F2. API contract

Generate an OpenAPI document from the Zod schemas and view models. Every endpoint documented with its authorization rule, request shape, response shape, and error cases.

Export TypeScript types for every view model to a single importable module.

**Done when:** the contract is complete enough that someone could build every screen in `docs/design-brief.md` without opening a backend file.

---

### F3. Seed data

A seed script producing a realistic synthetic district: 8 venues, 6 circles, 12 plans across both modes and every state, applications in every state per mode, one plan stuck at two attendees and auto-cancelled, one blocked pair, one restricted user, threads on viable plans only.

This is what the UI is developed against. It has to cover empty states, error states, and expired states, not just the happy path.

**Done when:** every state in every state machine is represented, in both modes, including non-viable and cancelled plans.

---

### F4. Adversarial suite

**Read:** `docs/security.md` in full

IDOR against every resource. Enumeration via ULID guessing and pagination. Capacity races. Ban evasion. A direct attack on each invariant in `CLAUDE.md` section 3. EXIF stripping verified with a GPS-tagged test image.

**Done when:** the suite runs in CI and fails the build on any regression.

---

## Not in scope

Do not build any of these without being asked:

- UI, components, styling, design system
- Assembly, in any form — no tables, endpoints, workers, or matching logic
- Payments
- Analytics beyond error monitoring
- Any recommendation or ranking system
- Real KYC vendor integration
- Anything listed under "Deliberately not doing" in `docs/todo.md`
