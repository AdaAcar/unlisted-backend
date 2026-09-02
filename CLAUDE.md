# CLAUDE.md

Project instructions for Claude Code. Read this before every task.

Full specifications are in `/docs`. This file is the short version plus the rules that must never be broken.

**Document precedence:** `docs/modes.md` is authoritative for anything mode-related and supersedes `docs/data-model.md` and `docs/api.md` where they conflict. Those two predate the two-mode design.

---

## Section ownership

**Sections 1–8 are read-only.** Do not edit them. If a rule here blocks a task, stop and ask.

**Sections 9–11 are yours to maintain.** Update them as you work, in the same commit as the code they describe.

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

For every task in `todo_claude.md`:

1. Read the referenced `/docs` sections.
2. Propose an approach in prose. No code yet. Wait for approval.
3. For anything touching authorization, capacity, viability, or visibility: write failing tests first, including the deny path, then implement.
4. Implement.
5. Update sections 9–11 of this file.
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

---

## 9. Progress

*Maintained by Claude Code. Update after every task.*

| Task | Status | Notes |
|---|---|---|
| A1. Bootstrap | **done** | Folder skeleton, `lib/config.ts`, TS/ESLint/Prettier/Vitest config, scripts, `.nvmrc`, `.gitignore`/`.gitattributes`, git history. `docs/` created; `modes.md`, `product.md`, `todo.md` moved in untouched. Verified on Node v24.19.0 / pnpm 9.15.4: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (3 pass), `pnpm dev` (Ready) all clean. `pnpm-lock.yaml` committed. |
| A2. Schema and migrations | **code complete; integration tests not yet executed** | 13 entities (no Assembly), `0000_init.sql` (drizzle-generated) + `0001_guards.sql` (hand-written: FK-to-generated-column, triggers, annotated `MIN_PLAN_TOTAL` literals, COMMENTs). `db/client.ts`, `lib/env.ts`, `drizzle.config.ts`, `docker-compose.yml`, `.env.example`. Verified: `pnpm typecheck`, `pnpm lint`, `pnpm test` unit suite (5 pass incl. the migration-parse test), and that `pnpm test` **fails loudly** without `TEST_DATABASE_URL`. **Not run:** the 3 integration test files (`schema-thread-viability`, `schema-smoke`) — the A2 session had no reachable Postgres (Docker Desktop needs interactive first-run; no local PG). To finish: `pnpm db:up`, set `TEST_DATABASE_URL` (`.env.example`), `pnpm test` — all green, then A2 is done. |
| A3. Repository layer | not started | Actor-scoped repositories; block + enforcement filters inside the query. Also picks up the deferred items from A2 §11 (app DB role + `audit_log` REVOKE; RLS enablement). |

## 10. Decisions made

*Maintained by Claude Code. Record any non-obvious implementation choice, with reasoning, so future sessions do not relitigate or contradict it.*

### A1

- **ESLint 8 + legacy `.eslintrc.json`, not ESLint 9 flat config.** `eslint-config-next` 15's stable, documented path is ESLint 8 with a legacy `.eslintrc`; flat-config support was still rough at bootstrap time. Revisit when `eslint-config-next` treats flat config as its default.
- **`@typescript-eslint/no-explicit-any` is `error` repo-wide.** CLAUDE.md section 2 forbids `any` only in `domain/` and `policy/`, but nothing in a backend of this shape needs it elsewhere, and one repo-wide rule is easier to keep honest than per-directory overrides. If a third-party type genuinely forces `any`, narrow it with an inline `// eslint-disable-next-line` + reason, do not loosen the rule.
- **`lib/config.ts` has no environment override.** No `process.env` read, no fallback, no merge. The section 5 values are structural invariants, not deployment configuration — `MIN_PLAN_TOTAL` especially must not be movable by whoever controls the deployment. Infrastructure config (DB/Redis URLs, session secrets) will live in a separate env module added by the task that first needs it, and will never be merged into `config`.
- **`next-env.d.ts` is committed, not gitignored.** Keeps `tsc --noEmit` working before the first `next dev` / `next build` generates it.
- **Dependency versions are pinned exactly (no `^`).** The npm registry was unreachable at bootstrap, so versions are pinned to known-good releases; `pnpm-lock.yaml` (committed after the first install) now governs.
- **Package manager pinned via `packageManager: pnpm@9.15.4`; Node floor `>=22.13.0` in `engines` and `.nvmrc` = `22`.** Verified toolchain is Node v24.19.0.
- **`docs/` layout.** Specs live in `docs/`; `CLAUDE.md` and `todo_claude.md` stay at repo root.
- **Vitest `@/*` alias is a direct `resolve.alias`, not `vite-tsconfig-paths`.** The package is not `"type": "module"`, so Vitest loads `vitest.config.ts` through a CommonJS `require`; `vite-tsconfig-paths` is ESM-only and blew up under `require`. Rejected `"type": "module"` (repo-wide semantic change — every `.js` becomes ESM, and any future CJS tool config, e.g. `.eslintrc.js` or a generated `*.config.js`, would need `.cjs`; not worth it for one file) and rejected renaming to `vitest.config.mts` (keeps the ESM-only dep plus an odd one-off extension). Instead: removed the dependency and set `resolve.alias['@'] = path.resolve(__dirname)`. Knock-ons: **`next.config.ts` and A2 are unaffected** — Next has its own TS/ESM config loader independent of `package.json` "type", and `drizzle-kit` loads `drizzle.config.ts` via its own esbuild loader. Cost: the `@` alias now lives in two files (`tsconfig.json` `paths` + `vitest.config.ts`), kept in sync by hand; it is one root-level entry. If aliases ever multiply, revisit via `vitest.config.mts` + `vite-tsconfig-paths`.

### A2

- **`viable_at` latch semantics — the single most likely thing for a future session to get wrong.** Both halves of `docs/modes.md` are right; they describe two different things.
  - `viable_at` **latches** on first crossing (`confirmed_total >= MIN_PLAN_TOTAL`) and **never clears**. It means *"introduction has occurred"*. You cannot un-introduce people — the thread stays, messages stay, mutual visibility stays. Enforced by the `enforce_plan_guards()` trigger, which rejects any `viable_at` → NULL update.
  - Whether the plan **proceeds** is evaluated **live**. At `starts_at`, if `confirmed_total < MIN_PLAN_TOTAL` the plan auto-cancels, regardless of `viable_at` being set. A latched plan that has dropped to 2 confirmed does not "meet".
  - Between a post-viability drop and `starts_at`, the plan is recoverable: the freed spot reopens applications if they had closed on spots-filled.
  - Net: **no dyad ever meets, because the plan cancels before it can.** The invariant protects the event, not the introduction.
- **ULID identifiers stored as `varchar(26)` text, not native `uuid`.** Debuggability — logs, `psql`, and error messages show the real, sortable ULID. Costs ~10 bytes/key over `uuid`; view models never expose raw IDs regardless. A Crockford-base32 `CHECK` on every id-bearing column is the constraint-level expression of "all IDs are ULIDs".
- **"No thread on a non-viable plan" is a foreign key to a generated column, not a trigger.** `plan.viable_plan_key` is `GENERATED ALWAYS AS (CASE WHEN viable_at IS NOT NULL THEN id END) STORED`, with a `UNIQUE` constraint; `message_thread.plan_id` is an FK to it. A thread for a non-viable plan has no FK target and the insert fails. Purely declarative, always-on, cannot be forgotten the way a trigger check could. It relies on `viable_at` being a monotonic latch (above) so the key never un-sets under a live thread; a secondary trigger enforces that monotonicity. `drizzle-kit` cannot emit an FK to a generated column, so `viable_plan_key`, its unique constraint, and this FK live in `0001_guards.sql`.
- **`plan.held_count`.** Planned-mode invitations place a soft hold on a spot. The capacity ceiling is `accepted_guest_count + held_count <= open_spots` (DB `CHECK`), not `accepted <= open_spots`. Without the held term, over-invitation would let two applicants accept the same spot. The column and its `CHECK` are in the schema now, deliberately, because altering a capacity constraint once there is production data is exactly what we do not want to do.
- **Viability is a denormalised counter pair + the latch timestamp**, written only inside the plan-row-locked transaction that changed attendance. `confirmed_total` is a stored generated column (`confirmed_host_count + accepted_guest_count`). Not computed-on-read (the FK needs a stored target); not a generated `viable_at` (it must be a first-crossing timestamp and a latch).
- **`MIN_PLAN_TOTAL` literal `3` appears exactly twice in SQL**, both in `0001_guards.sql`, each annotated `/* MIN_PLAN_TOTAL: keep equal to lib/config.ts */`: the `viable_at` set-time floor in `enforce_plan_guards()`, and `message_thread_min_participants_chk`. `tests/unit/migration-min-plan-total.test.ts` parses both and asserts `=== config.MIN_PLAN_TOTAL`. SQL can't import the TS constant; this annotation is the single checkable link. `message_thread.participant_count`'s `>= 3` check is therefore defined in `0001_guards.sql`, not in the Drizzle table — the one place `db/schema/` is not the source of truth.
- **Native Postgres enums** (`pgEnum`), not text + `CHECK IN (…)`, so "valid state enums" is a DB guarantee. `application.state` is the union of both mode machines; a mode-scoped `CHECK` keeps `approved` out of planned and `invited`/`shortlisted`/… out of tonight.
- **`plan.venue_type` and `plan.district` are denormalised from the venue** so the discovery query filters without a join. `district` is specified by `docs/data-model.md`; `venue_type` is the same rationale applied to the C4 type filter.
- **`docs/data-model.md`'s "explicit transition log" = the `audit_log`** (before/after state per state-changing action). No per-entity transition tables.
- **`lib/env.ts` is a hand-rolled validator, not Zod.** `zod` was not in the approved A2 dependency list and env parsing here is two connection strings. When a request-body schema first needs Zod (B1/A5), add it then. `env` values are read lazily via getters so importing the module never throws.
- **`vitest.config.ts` sets `fileParallelism: false`.** Integration tests drop/recreate the `public` schema of one shared test DB; parallel files would clobber each other. Suite is small; serial costs nothing. Revisit with per-file databases if the suite grows.

## 11. Known gaps

*Maintained by Claude Code. Anything deliberately deferred, stubbed, or left incomplete. Be specific — a vague entry here is how a stub reaches production.*

- **`app/` holds only `app/api/.gitkeep`.** No route handlers, no root layout. `next build` will produce an app with no routes. Expected until phase C.
- **`pnpm test` prints "The CJS build of Vite's Node API is deprecated".** Cosmetic warning from Vitest 2.x loading its config via CJS; tests pass. It disappears with `"type": "module"`, which we are deliberately not adding (see section 10). Revisit if a Vitest/Vite upgrade makes it an error.
- **Placeholder modules** (`domain/`, `policy/`, `views/`, `workers/`) are `export {}` only. `db/` now has the schema + connection wiring; repositories are A3.

### A2

- **Integration tests were not executed against real Postgres in the A2 session.** No reachable DB (Docker Desktop needs interactive first-run; no local PG). The 3 files are written and `pnpm test` fails loudly without `TEST_DATABASE_URL`, but the 5 constraint assertions (thread-viability FK, distinct-circles, participant floor, `viable_at` latch, append-only `audit_log`, non-ULID PK) have **not been proven green**. First action for the next session with Docker: `pnpm db:up`, set `TEST_DATABASE_URL`, `pnpm test`; fix any fallout; then mark A2 done in §9.
- **RLS is not enabled.** `docs/security.md` wants Postgres row-level security as defence in depth. Tables ship with RLS off; enabling it needs the actor model — A3/A5.
- **Encryption at rest for `identity_hash` / `verification_ref` is not implemented.** They are separate columns with a `COMMENT` annotation only. Mechanism (pgcrypto or app-layer envelope + column-level access control) is **B2**.
- **No application DB role exists, so `audit_log` append-only rests on triggers only.** The `REVOKE UPDATE, DELETE` is deferred to **A3** when the role is created. Noted in `0001_guards.sql`.
- **Viability counter reconciliation is not built.** `confirmed_host_count` / `accepted_guest_count` are only ever mutated by the (future) domain helper under the plan row lock. A worker that recomputes them from `circle_member` / `application_member` and alerts on drift is **E-phase**; the C7c/F4 adversarial test that asserts `confirmed_total` equals the real confirmed-row count over every action sequence is those tasks.
- **No `ThreadParticipant` table.** `message_thread.participant_count` is a denormalised counter (with the `>= 3` check). Participant identity for read authorization is derived at thread creation — **C8**.
- **`circle.lead_user_id` ↔ `circle_member(role='lead', status='active')` consistency is domain-only.** No DB constraint (cross-row). Enforce in the C1 domain layer.
- **`0001_guards.sql` is the one file where `db/schema/` is not the source of truth** (the FK-to-generated-column, `viable_plan_key`, `participant_count >= 3`, all triggers/functions, COMMENTs). A future `drizzle-kit generate` will not see these; do not let it try to "add" or "drop" them.
