# Project state

Current status, decisions, and known gaps. Maintained by whichever agent is working the repo, updated in the same commit as the code it describes. `docs/agent-rules.md` governs; this file records.

---

## Handoff

You are picking this up cold. Read `docs/agent-rules.md` in full first, then this whole file, then `todo_agent.md`. The A3 spec is `docs/a3-plan.md` — build from it; its open questions are already answered and folded in.

### Where things stand

- **A1 (bootstrap): done and verified.** Next.js App Router + TypeScript (`strict`, `noUncheckedIndexedAccess`), Drizzle, Vitest. Folder skeleton per agent-rules section 4 with a placeholder in each. `lib/config.ts` holds the section-5 constants and **reads nothing from the environment** — no `process.env`, no override. Scripts: `dev build start lint typecheck format format:check test test:watch db:generate db:migrate db:up db:down`. Verified: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm dev` all clean on Node v24.19.0 / pnpm 9.15.4.
- **A2 (schema + migrations): done and verified against real Postgres.** 13 entities (`user record circle circle_member venue plan application application_member message_thread message signal block audit_log`). **No Assembly table.** ULID `varchar(26)` PKs with a Crockford-format `CHECK` throughout; `timestamptz` everywhere; native `pgEnum` for every state column. `0000_init.sql` is drizzle-generated; `0001_guards.sql` is hand-written (see traps). `db/client.ts` (lazy pool + Drizzle client, no query helpers), `lib/env.ts` (env parsing — hand-rolled today, **A3 replaces it with Zod**), `drizzle.config.ts`, `docker-compose.yml`, `.env.example`. Full `pnpm test` (unit + integration) was run green against `postgres:16`.
- **A3 (repository layer): not started.** Spec in `docs/a3-plan.md`. Scope: actor-scoped `plans` and `users` repositories only, the scoping infrastructure (`db/scope/*`), the named admin module, RLS + three DB roles, and the Zod rewrite of `lib/env.ts`. Not endpoints, not `policy/`, not auth.

### Verified vs merely written

Everything in A1 and A2 is **verified** — it was run. `pnpm test` passes end to end with Postgres up. Nothing in A1/A2 is "written but unproven" any more. A3 is entirely unwritten.

### Bring up Postgres and run the suite

```bash
pnpm install
pnpm db:up          # docker compose: postgres:16 on localhost:5433, user/pass/db = unlisted / unlisted / unlisted_test
```

Then put this in `.env.local` (git-ignored; `tests/setup/env.ts` loads it and never overrides a real env var):

```
DATABASE_URL=postgres://unlisted:unlisted@localhost:5433/unlisted_test
TEST_DATABASE_URL=postgres://unlisted:unlisted@localhost:5433/unlisted_test
```

```bash
pnpm test           # unit + integration. FAILS LOUDLY (does not skip) if TEST_DATABASE_URL is unset — by design.
pnpm typecheck
pnpm lint
pnpm format:check
```

Docker Desktop on this machine needed an interactive first-run before `pnpm db:up` worked. If `docker ps` errors, start Docker Desktop and wait.

### Traps

- **`db/migrations/0001_guards.sql` is hand-written and load-bearing.** It holds every invariant Drizzle cannot express from the schema: the FK from `message_thread.plan_id` to `plan.viable_plan_key` (a `STORED` generated column that equals the plan id only while `viable_at IS NOT NULL`, with a `UNIQUE` constraint — this is what makes "no thread on a non-viable plan" structural rather than a forgettable check); the `viable_plan_key` column and its unique constraint; `message_thread_min_participants_chk` (`participant_count >= 3`); the `set_updated_at` trigger + per-table triggers; `enforce_plan_guards()` (mode immutability + `viable_at` latch + set-time floor); the `audit_log` append-only triggers; restricted-column `COMMENT`s. A `drizzle-kit generate` will not see any of this. Do not let a regeneration try to "add" or "drop" these, and if you change the schema, re-check that `0001_guards.sql` still applies cleanly after the new `0000`.
- **`viable_at` latch semantics — the single most likely thing to get wrong.** `viable_at` is set the first time `confirmed_total >= MIN_PLAN_TOTAL` and **never clears** (`enforce_plan_guards()` rejects clearing it). It means *"introduction has occurred"* — the thread, messages, and mutual visibility that follow are permanent and are never undone. Whether the plan **proceeds** is a *separate, live* question: at `starts_at`, if `confirmed_total < MIN_PLAN_TOTAL` the plan auto-cancels regardless of `viable_at` being set. A latched plan that dropped to two confirmed does not meet — it cancels first. The invariant protects the event, not the introduction. Both halves of `docs/modes.md` are correct; they describe these two different things.
- **`MIN_PLAN_TOTAL` (`3`) appears in SQL exactly twice**, both in `0001_guards.sql`, each annotated `/* MIN_PLAN_TOTAL: keep equal to lib/config.ts */`: the `viable_at` set-time floor in `enforce_plan_guards()`, and `message_thread_min_participants_chk`. `tests/unit/migration-min-plan-total.test.ts` parses both and asserts each equals `config.MIN_PLAN_TOTAL` and that there are exactly two. If you touch either literal, keep the annotation and keep them equal to `lib/config.ts`. SQL cannot import the TS constant; that annotation is the only checkable link.
- **No Assembly table exists and none should.** `docs/data-model.md` describes an `Assembly` entity; it is deferred and explicitly not built. The three-person floor plus the viability gate cover what it would have done. Do not add assembly tables, endpoints, or workers.
- **`data-model.md` and `api.md` predate the two-mode design.** Where they disagree with `docs/modes.md` (Plan `mode` / `viable_at` / `applications_closed_at`, the Assembly table, the `MessageThread` rule stated in participant-count terms, the `approve` endpoint), `modes.md` wins — this is settled, do not re-ask.

### Things not written down elsewhere

- **Toolchain / environment.** Built on Windows 10, Node **v24.19.0**, pnpm **9.15.4** (pinned via `packageManager`). On the build machine, `node`/`pnpm` were not on the default `PATH` and had to be picked up from the Machine+User environment; a fresh agent's shell may differ. `.nvmrc` says `22`; `engines.node` is `>=22.13.0`.
- **git.** Repo is initialized, branch `main`, ~8 commits, **no remote, never pushed**. Local git identity was set to `Ada <dinc.acar@gmail.com>` because no global git config existed — verify this is who you should be committing as. On Windows, PowerShell mangled a `git commit -m @'...'@` here-string containing `<`/`<=`; use `git commit -F <file>` for multi-line messages.
- **Spec provenance.** The original spec bundles are `C:\Users\Ada\Desktop\Weddit\files.zip` (the five specs: architecture, data-model, api, security, safety) and `files_build.zip` (agent-rules content, todo, modes, product, todo). They are outside the repo. `docs/modes.md`, `docs/product.md`, `docs/todo.md` are the newer generation; the five specs were extracted from the older `files.zip` (2026-09-01) at the start of A2.
- **`ulidx`, not `ulid`,** is the ULID library.
- **`next lint` only lints the dirs named in the `lint` script's `--dir` flags.** If you add a new top-level source directory, add it to that script or it goes unlinted.
- **`vitest.config.ts` sets `fileParallelism: false`** because the integration tests all `DROP SCHEMA public CASCADE` on one shared test database. Keep it until tests get per-file databases.
- **`db/migrations/` is prettier-ignored** and drizzle-owned. `meta/` is machine-generated — never hand-edit. `0001_guards.sql` is the deliberate exception: hand-edited on purpose.
- **No CI.** Tests are run by hand. There is no pipeline gating commits.
- **`pnpm test` prints "The CJS build of Vite's Node API is deprecated"** — cosmetic, harmless, tests pass. It would go away with `"type": "module"`, which is deliberately not set (see Decisions).
- **`AGENTS.md` and `CLAUDE.md` are identical 3-line stubs** that redirect here. `todo_agent.md`'s body still says "Read `CLAUDE.md` first"; that redirect works, but `docs/agent-rules.md` is the real entry point.
- **Stale `CLAUDE.md section N` pointers in code comments.** Source comments in `db/schema/*.ts`, `next.config.ts`, `lib/config.ts`, `db/migrations/0001_guards.sql`, `todo_agent.md`, and a couple of test files still say "CLAUDE.md section N". The section numbers are unchanged, so section 1–8 refs now mean `docs/agent-rules.md` and section 9–11 refs mean `docs/state.md`. Left as-is in the handoff commit to keep it small; fix opportunistically when you touch those files.

---

## 9. Progress

*Maintained by the working agent. Update after every task.*

**Claim protocol:** before starting a task, set its `Claimed by` cell to your agent id and commit that one-line change on its own. One agent per task. Clear it (back to `—`) or set it to `done` when the task closes.

| Task | Status | Claimed by | Notes |
|---|---|---|---|
| A1. Bootstrap | **done** | — | Folder skeleton, `lib/config.ts`, TS/ESLint/Prettier/Vitest config, scripts, `.nvmrc`, `.gitignore`/`.gitattributes`, git history. `docs/` created; `modes.md`, `product.md`, `todo.md` moved in untouched. Verified on Node v24.19.0 / pnpm 9.15.4: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (3 pass), `pnpm dev` (Ready) all clean. `pnpm-lock.yaml` committed. |
| A2. Schema and migrations | **done** | — | 13 entities (no Assembly), `0000_init.sql` (drizzle-generated) + `0001_guards.sql` (hand-written: FK-to-generated-column, triggers, annotated `MIN_PLAN_TOTAL` literals, COMMENTs). `db/client.ts`, `lib/env.ts`, `drizzle.config.ts`, `docker-compose.yml`, `.env.example`. Verified: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, full `pnpm test` green against Postgres 16 (`pnpm db:up`) — unit (migration-parse) + all integration (thread-viability FK, distinct-circles, participant floor, `viable_at` latch, append-only `audit_log`, non-ULID PK reject, migrations apply clean). `pnpm test` also verified to fail loudly without `TEST_DATABASE_URL`. |
| A3. Repository layer | not started | unclaimed | Spec: `docs/a3-plan.md`. Actor-scoped `plans` + `users` repositories only; scoping infra (`db/scope/*`); named admin module; RLS + three DB roles; replace hand-rolled `lib/env.ts` with Zod (dependency approved). Also clears the deferred A2 items below (app DB role + `audit_log` REVOKE; RLS enablement). |

## 10. Decisions made

*Maintained by the working agent. Record any non-obvious implementation choice, with reasoning, so future sessions do not relitigate or contradict it. Per agent-rules section 9, entries here are final — disagree by stopping and asking, not by changing them.*

### A1

- **ESLint 8 + legacy `.eslintrc.json`, not ESLint 9 flat config.** `eslint-config-next` 15's stable, documented path is ESLint 8 with a legacy `.eslintrc`; flat-config support was still rough at bootstrap time. Revisit when `eslint-config-next` treats flat config as its default.
- **`@typescript-eslint/no-explicit-any` is `error` repo-wide.** `docs/agent-rules.md` section 2 forbids `any` only in `domain/` and `policy/`, but nothing in a backend of this shape needs it elsewhere, and one repo-wide rule is easier to keep honest than per-directory overrides. If a third-party type genuinely forces `any`, narrow it with an inline `// eslint-disable-next-line` + reason, do not loosen the rule.
- **`lib/config.ts` has no environment override.** No `process.env` read, no fallback, no merge. The section 5 values are structural invariants, not deployment configuration — `MIN_PLAN_TOTAL` especially must not be movable by whoever controls the deployment. Infrastructure config (DB/Redis URLs, session secrets) will live in a separate env module added by the task that first needs it, and will never be merged into `config`.
- **`next-env.d.ts` is committed, not gitignored.** Keeps `tsc --noEmit` working before the first `next dev` / `next build` generates it.
- **Dependency versions are pinned exactly (no `^`).** The npm registry was unreachable at bootstrap, so versions are pinned to known-good releases; `pnpm-lock.yaml` (committed after the first install) now governs.
- **Package manager pinned via `packageManager: pnpm@9.15.4`; Node floor `>=22.13.0` in `engines` and `.nvmrc` = `22`.** Verified toolchain is Node v24.19.0.
- **`docs/` layout.** Specs live in `docs/`. (Superseded in detail by the A3 handoff restructure below — the agent rules now live in `docs/agent-rules.md` and this file is `docs/state.md`; `AGENTS.md` / `CLAUDE.md` are redirect stubs.)
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
- **`lib/env.ts` moves to Zod in A3.** `zod` is approved as a dependency (agent-rules section 2 pinned stack). The A2 hand-rolled validator was a stopgap taken because `zod` was not on the approved A2 dep list; A3 replaces it. `env` values stay lazily read so importing the module never throws.
- **`vitest.config.ts` sets `fileParallelism: false`.** Integration tests drop/recreate the `public` schema of one shared test DB; parallel files would clobber each other. Suite is small; serial costs nothing. Revisit with per-file databases if the suite grows.

### A3 (decided, not yet built — see `docs/a3-plan.md`)

- **Repository restructure of the instruction files.** `CLAUDE.md` sections 1–8 → `docs/agent-rules.md`; sections 9–11 → this file (`docs/state.md`); `todo_claude.md` → `todo_agent.md`; `AGENTS.md` and `CLAUDE.md` are now identical redirect stubs. Rules read-only in `agent-rules.md`; living record here.
- **Q1 — unscoped queries are made impossible by two stacked mechanisms, and RLS + three roles stay in A3 (not deferred).** (a) Structural chokepoint: the Drizzle client and `pg` `Pool` are not exported to app code; the only way to run a query is `withActor(actor, fn)`, which cannot be called without an `Actor`. (b) The teeth: Postgres RLS, `ENABLE` + `FORCE` on every table, policies that begin `current_setting('app.actor_id', true) IS NOT NULL AND …` with no permissive policy matching when the GUC is unset — a query outside `withActor` returns zero rows, not an error. `withActor` sets `app.actor_id` / `app.actor_standing` transaction-locally. Three DB roles: `unlisted_migrator` (owner, migrations), `unlisted_app` (RLS-subject, `withActor`), `unlisted_admin` (`BYPASSRLS`, `db/admin/` only). An ESLint `no-restricted-imports` rule + a static test are the backstop, not the mechanism.
- **Q2 — block + enforcement filters are composed once, applied everywhere, reimplemented never.** `db/scope/visibility.ts` exports `blockPredicate(actorId, counterpartyUserIdExpr)` (bidirectional `NOT EXISTS` over `block`), `enforcementPredicate(...)`, a declarative `VisibilitySpec` per table (how to reach the counterparty user id — column or correlated join path), and `applyVisibility(qb, actor, spec)` which `AND`s them in as correlated `EXISTS`/`NOT EXISTS` subqueries (independent of SELECT list / joins / grouping). The chokepoint applies it automatically for the table being queried; repo functions only add business filters. RLS carries the same block + standing rules independently as its `USING` predicates, cross-referenced in comments to `visibility.ts` as the authored source. `restricted` standing: hidden from other actors' feeds, visible to self. `suspended` / `banned`: same. The finer "affected parties" nuance is A5/D4.
- **Q3 — the `Actor` shape, and its origin before B1 exists.** `UserActor = { kind: 'user'; id; verificationState; standing }`; `SystemActor = { kind: 'system'; label }`; `Actor` is the union. No precomputed block set on the actor — blocks are a live correlated subquery keyed on `actor.id`. A3 ships the type + `SYSTEM_ACTOR` + `loadActorByUserId(userId)` (reads `id`, `verification_state`, `standing` from `user` — a narrow named data read, not authentication). Tests build `UserActor` literals from seed rows. B1 later adds `getSessionActor(request)` in front of `loadActorByUserId`; the `Actor` shape and the loader do not change. Repositories depend only on the `Actor` interface, never on how it was produced. Moderator capabilities are not an actor field yet (D4).
- **A3 repository breadth: `plans` and `users` only.** They prove the pattern and satisfy the "done when". Phase-C tasks build `circles` / `applications` / `threads` / `messages` repositories against the same infrastructure. No thin stubs for the others.

## 11. Known gaps

*Maintained by the working agent. Anything deliberately deferred, stubbed, or left incomplete. Be specific — a vague entry here is how a stub reaches production.*

- **`app/` holds only `app/api/.gitkeep`.** No route handlers, no root layout. `next build` will produce an app with no routes. Expected until phase C.
- **`pnpm test` prints "The CJS build of Vite's Node API is deprecated".** Cosmetic warning from Vitest 2.x loading its config via CJS; tests pass. It disappears with `"type": "module"`, which we are deliberately not adding (see section 10). Revisit if a Vitest/Vite upgrade makes it an error.
- **Placeholder modules** (`domain/`, `policy/`, `views/`, `workers/`) are `export {}` only. `db/` now has the schema + connection wiring; repositories are A3.

### A2

- **RLS is not enabled.** `docs/security.md` wants Postgres row-level security as defence in depth. Tables ship with RLS off; enabling it is part of A3 (see decision above).
- **Encryption at rest for `identity_hash` / `verification_ref` is not implemented.** They are separate columns with a `COMMENT` annotation only. Mechanism (pgcrypto or app-layer envelope + column-level access control) is **B2**.
- **No application DB role exists, so `audit_log` append-only rests on triggers only.** The `REVOKE UPDATE, DELETE` is deferred to **A3** when the role is created. Noted in `0001_guards.sql`.
- **Viability counter reconciliation is not built.** `confirmed_host_count` / `accepted_guest_count` are only ever mutated by the (future) domain helper under the plan row lock. A worker that recomputes them from `circle_member` / `application_member` and alerts on drift is **E-phase**; the C7c/F4 adversarial test that asserts `confirmed_total` equals the real confirmed-row count over every action sequence is those tasks.
- **No `ThreadParticipant` table.** `message_thread.participant_count` is a denormalised counter (with the `>= 3` check). Participant identity for read authorization is derived at thread creation — **C8**.
- **`circle.lead_user_id` ↔ `circle_member(role='lead', status='active')` consistency is domain-only.** No DB constraint (cross-row). Enforce in the C1 domain layer.
- **`0001_guards.sql` is the one file where `db/schema/` is not the source of truth** (the FK-to-generated-column, `viable_plan_key`, `participant_count >= 3`, all triggers/functions, COMMENTs). A future `drizzle-kit generate` will not see these; do not let it try to "add" or "drop" them.
