# Agent rules

Governs all work in this repo. Read this before every task.

Full specifications are in `docs/`. This file is the short version plus the rules that must never be broken.

**Document precedence:** `docs/modes.md` is authoritative for anything mode-related and supersedes `docs/data-model.md` and `docs/api.md` where they conflict. Those two predate the two-mode design.

---

## Document structure

**This file (`docs/agent-rules.md`) is read-only.** Do not edit it. If a rule here blocks a task, stop and ask.

**`docs/state.md` is the living record** — progress, decisions made, and known gaps. Update it as you work, in the same commit as the code it describes.

---

## 1. What this is

Unlisted — a group-to-group social app. Someone posts a plan at a public venue with open spots; other people and groups apply; the poster decides who joins.

**The defining rule: no plan ever becomes a meeting between two people.** Enforced by the viability rule in section 3.

Two plan modes exist — planned and tonight. Read `docs/modes.md` before touching anything in the plan or application lifecycle.

You are building the **backend only**. The UI will be built separately against the API contract you produce. Do not build screens, components, or styling. Route handlers, domain logic, data layer, and tests only.

## 2. Stack

Pinned. Do not substitute.

- Next.js App Router, route handlers under `app/api`
- TypeScript, `strict: true`, no `any` in `domain/` or `policy/`
- Postgres via Drizzle ORM
- Auth.js, server-side sessions
- Zod for all input validation
- Redis for rate limits, idempotency, and locks
- Vitest for unit and integration tests

Ask before adding any dependency.

## 3. Invariants

Product rules encoded as code rules. Never violate one, never "simplify" one away, never add a feature that requires an exception.

**The viability rule — the most important invariant in this codebase**

```
plan.viable  ⟺  confirmed host members + accepted guests >= MIN_PLAN_TOTAL
```

- No message thread row may exist for a non-viable plan. Enforce in the database, not only in application code.
- Guests are not visible to each other before viability.
- A non-viable plan auto-cancels at `starts_at`, and nobody learns who else was involved.

This is what allows a single person to post a plan without the product producing one-on-one meetings. It must not be weakened.

**Structure**

- No one-on-one anything. A message thread requires two circle references and a viable plan.
- No user list endpoint. No user search. No browsable people directory. If a task seems to need one, stop and ask.
- A profile is readable only if the actor shares a plan context with the subject. Otherwise 404.
- `MIN_PLAN_TOTAL` is 3 and is not a tuning parameter. Never lower it, never add a path that bypasses it.

**Identifiers and serialization**

- All IDs are ULIDs. Never sequential integers, never exposed database keys.
- Never serialize a domain entity to a client. Every response goes through an explicit view model in `views/`.
- 404, not 403, for resources the actor may not see. Distinguishing them leaks existence.

**Authorization**

- All authorization lives in `policy/`. Never inline an ownership check in a route handler.
- Deny by default. An action with no matching rule is denied.
- Block and enforcement filters apply inside the repository query, never as a filter on fetched results.

**Data handling**

- Strip EXIF server-side on every uploaded image before storage.
- No personal data in URLs, query strings, logs, notification bodies, or analytics payloads.
- Never store a date of birth. Store the age asserted by the verification vendor.
- Never log full names, photo URLs, message bodies, plan-attendee pairings, or verification references.

**Concurrency**

- Any capacity-affecting transition takes a row lock on the plan inside a transaction. Never read-then-write.
- Every state-changing endpoint accepts an idempotency key.

## 4. Repo layout

```text
app/api/          Route handlers. Thin: validate, authorize, call domain, return view model.
domain/           Entities, state machines, invariants. Pure where possible. No DB imports.
policy/           The single authorization module.
db/               Drizzle schema, migrations, repositories.
views/            View models. One per audience per entity.
workers/          Scheduled jobs.
lib/              Config, validation helpers, ULID, rate limiting.
tests/            unit/ integration/ adversarial/
docs/             Specifications. Read these; do not edit them.
```

Domain logic never lives in a route handler. Database access never happens outside `db/`.

## 5. Configuration

Every product parameter lives in `lib/config.ts`. Never inline a magic number.

```ts
MIN_HOST_CIRCLE         = 1
MIN_APPLICANT_CIRCLE    = 1
MIN_PLAN_TOTAL          = 3     // structural. not tunable.

SPONTANEOUS_THRESHOLD_H = 24    // below this at publish → tonight mode
RESPONSE_DEADLINE_MAX_H = 12
RESPONSE_DEADLINE_MIN_M = 15
RESPONSE_DEADLINE_RATIO = 0.25
```

Assembly is deferred and not built. Do not implement assembly tables, endpoints, or workers.

Never hardcode any of these anywhere else.

## 6. Workflow

For every task in `todo_agent.md`:

1. Read the referenced `/docs` sections.
2. Propose an approach in prose. No code yet. Wait for approval.
3. For anything touching authorization, capacity, viability, or visibility: write failing tests first, including the deny path, then implement.
4. Implement.
5. Update `docs/state.md` (progress, decisions made, known gaps), in the same commit as the code.
6. Report what you changed and what you deliberately did not.

One task per session. Do not start the next task without being asked.

## 7. Stop and ask

Never invent an answer to these. Stop and ask.

- Any change to a value in section 5
- Anything that would require a user list, user search, or a person-browsing surface
- Anything that creates a channel between two individuals, or a thread on a non-viable plan
- Adding a dependency
- Any change to the retention schedule or what gets logged
- Implementing assembly
- Anything the docs mark as an open decision

## 8. Test standard

- Every endpoint has an integration test asserting the **deny** path, not only the allow path. An authorization test that only covers the happy path is worse than none.
- Every state machine has exhaustive tests on invalid transitions, per mode.
- `tests/adversarial/` covers IDOR across every resource, enumeration, capacity races, ban evasion, and a direct attack on each invariant in section 3 — including an attempt to reach a two-person plan through every available sequence of actions.
- Tests use synthetic seed data. Never fixtures derived from real data.

## 9. Recorded decisions are final

Decisions recorded in `docs/state.md` (the "Decisions made" section) are never to be reversed, reinterpreted, or worked around. An agent that disagrees with a recorded decision **stops and asks the user** — it does not change the decision, and it does not build something that quietly contradicts it. New decisions are additive and must not negate an existing one without the user explicitly saying so.
