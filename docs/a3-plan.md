# A3 — Repository layer

This is the spec the next agent builds from. The three design questions that were open at plan time have been answered by the user and are folded in below as **decided**. Follow `docs/agent-rules.md` section 6 (propose, get approval on anything you'd change, then implement). If you disagree with a decision here or in `docs/state.md`, stop and ask — do not reverse it.

Task source: `todo_agent.md` → A3.

---

## Scope

The scoping *infrastructure*, plus two concrete repositories that exercise every part of it (`plans`, `users`), plus the named admin module, plus RLS as the DB-level backstop. Other entity repos (`circles`, `applications`, `threads`, `messages`) are built by their Phase-C tasks against this same pattern — A3 establishes and proves the pattern, it does not need all 13.

Also in A3, as carried over from A2: replace the hand-rolled `lib/env.ts` with Zod; create the application DB role and apply the `audit_log` `REVOKE` deferred from A2.

**Not in A3:** endpoints, `policy/` rules, auth/session resolution.

## Dependency to add

`zod` (approved). Nothing else.

## New / changed files

```
db/scope/actor.ts          Actor types + SYSTEM_ACTOR. No auth.
db/scope/resolve.ts        loadActorByUserId(userId) — reads {id, verificationState, standing} from `user`. The B1 seam.
db/scope/visibility.ts     block + enforcement predicate builders; VisibilitySpec; applyVisibility().
db/scope/scoped.ts         withActor(actor, fn) — the transaction + GUC chokepoint. Only way to get a query executor.
db/repositories/plans.ts   feed(actor, filters), get(actor, id) — actor-first, visibility auto-applied.
db/repositories/users.ts   getProfile(actor, subjectId) — 404 unless shared plan context.
db/repositories/index.ts   re-exports repositories only. Never the raw client.
db/admin/index.ts          adminDb (BYPASSRLS role). The single explicitly-named unscoped surface.
db/migrations/0002_rls.sql roles + ENABLE/FORCE RLS + deny-by-default + block/standing policies.
lib/env.ts                 rewritten with Zod; adds APP_DATABASE_URL, ADMIN_DATABASE_URL.
db/client.ts               keep getPool/getDb for migrations+tests+admin; app code no longer imports it directly.
```

Tests: `repo-block-scoping` (the done-when), `repo-enforcement-visibility`, `rls-deny-by-default`, `no-unscoped-query` (static), `env` (Zod).

---

## Q1 (decided) — an unscoped query is *impossible*, not discouraged. RLS and the three roles stay in A3; they are not deferred.

Two mechanisms stacked; the second is the one that survives a bug.

### (a) Structural chokepoint — you cannot obtain a query handle without an actor

The Drizzle client (`getDb`) and `pg` `Pool` stop being exported from anything app code can reach. They live in `db/client.ts`, imported by exactly three modules: `db/scope/scoped.ts`, `db/admin/index.ts`, and the test/migration harness. `db/index.ts` and `db/repositories/index.ts` re-export **repository functions only**.

The sole way to run a query in application code is:

```
withActor(actor, async (q) => { ... })   // q is a transaction-bound executor
```

`withActor` requires an `Actor` as its first argument — there is no overload without one. A new repository function physically cannot start a query without receiving an actor and passing it in. "Forgot to scope" isn't reachable because "unscoped" isn't a state you can construct.

A `no-restricted-imports` ESLint rule + a static test (`no-unscoped-query.test.ts`) forbid importing `pg` or `drizzle-orm/node-postgres` anywhere under `db/` except those three files, and forbid `.select(` / `.$client` on a raw client outside `db/scope/` and `db/admin/`. This is the backstop, not the mechanism.

### (b) The teeth — Postgres RLS, deny-by-default when the actor GUC is unset

`withActor` opens a transaction and, before yielding, runs:

```
SELECT set_config('app.actor_id', $1, true);      -- true = transaction-local
SELECT set_config('app.actor_standing', $2, true);
```

`0002_rls.sql` does, for every table: `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` (so even the table owner is subject), then policies whose `USING` clause begins with `current_setting('app.actor_id', true) IS NOT NULL AND …`. There is **no permissive policy that matches when `app.actor_id` is unset**. Result: a connection that runs a bare `SELECT * FROM plan` without going through `withActor` — a future bug, a stray script, `psql` as the app role — gets **zero rows**, not an error, not a leak. This is what `docs/security.md` layer:data asks for: "on the assumption the application layer will eventually have a bug."

Role separation makes "admin" a real boundary, not a naming convention:

| Role | RLS | Used by | Connection string |
|---|---|---|---|
| `unlisted_migrator` (owner) | n/a | migrations only | `DATABASE_URL` |
| `unlisted_app` | subject (FORCE) | `withActor` | `APP_DATABASE_URL` |
| `unlisted_admin` | `BYPASSRLS` | `db/admin/` only | `ADMIN_DATABASE_URL` |

`db/admin/` is the only module holding a connection that can see across actors, and it is one file, imported by nothing under `db/repositories/`.

`0002_rls.sql` creates the roles and grants (it runs as `unlisted_migrator` / the compose superuser). `docker-compose.yml` and `.env.example` gain `APP_DATABASE_URL` and `ADMIN_DATABASE_URL`. `freshDb()` in the test helper migrates as the owner, then the repo tests connect as `unlisted_app`; `rls-deny-by-default.test.ts` connects as `unlisted_app` with no GUC set and asserts zero rows.

---

## Q2 (decided) — block + enforcement filters are composed once and applied everywhere; no repo function reimplements them. `restricted` standing is hidden from other actors' feeds and visible to self; `suspended` / `banned` the same. The finer "affected parties" nuance is A5/D4.

**Predicates as data + one applier.**

`db/scope/visibility.ts` exports:

- `blockPredicate(actorId, counterpartyUserIdExpr)` → a bidirectional `NOT EXISTS (SELECT 1 FROM block b WHERE (b.blocker_user_id = :actorId AND b.blocked_user_id = <expr>) OR (b.blocker_user_id = <expr> AND b.blocked_user_id = :actorId))`. Written once.
- `enforcementPredicate(actorId, counterpartyUserIdExpr, counterpartyStandingExpr)` → `(<standing> NOT IN ('suspended','banned','restricted') OR <userIdExpr> = :actorId)`. Written once. `restricted` = plans/applications not surfaced to other actors; self exempt. Moderator exemption is A5/D4, not here.
- A `VisibilitySpec` type: for a given table, *how to reach the counterparty user id(s)* — a column, or a correlated-subquery join path. Examples:
  - `plan` → "any active member of `host_circle_id`": `EXISTS (SELECT 1 FROM circle_member cm WHERE cm.circle_id = plan.host_circle_id AND cm.status = 'active' AND <predicate over cm.user_id>)`, negated appropriately.
  - `user` → the row's own `id` / `standing`.
  - `message` → `sender_user_id`.
- `applyVisibility(queryBuilder, actor, spec)` → `AND`s `blockPredicate` and `enforcementPredicate` (composed per the spec's join path) into the builder's `WHERE`. Because it emits **correlated `EXISTS`/`NOT EXISTS` subqueries**, it is independent of the outer query's SELECT list, joins, grouping, or whether it is a `feed` or a `count` — the same clause works everywhere.

The chokepoint wires it in: `withActor` (or a thin `scopedSelect(actor, table, spec)` it provides) applies `applyVisibility` automatically for the table being queried. A repo function like `plans.feed` then only writes its *business* filters (`state='published'`, district, `starts_at` window, `open_spots > 0`); the visibility clause is already there and it did not type it.

RLS (Q1b) carries the **same** block + standing rules independently, as its `USING` predicates. The two are parallel implementations of one spec — keep the SQL fragments in `visibility.ts` as the single authored source and have `0002_rls.sql` mirror them with a comment cross-referencing the file, plus a test that inserts a blocked pair and asserts *both* the repo path and a raw `unlisted_app` `SELECT` hide the row. The contextual rule that RLS can't easily express (profile visible only within shared plan context) stays app-layer only, documented.

---

## Q3 (decided) — the `Actor` shape and where it comes from before B1

**Carries** (minimum the data layer needs; `policy/` reads the same object in A5):

```
UserActor   = { kind: 'user';   id: Ulid; verificationState: 'none'|'pending'|'verified'|'failed'; standing: 'good'|'restricted'|'suspended'|'banned' }
SystemActor = { kind: 'system'; label: string }          // workers / retention / pattern detection
Actor       = UserActor | SystemActor
```

- No precomputed block set on the actor — blocks are applied as a live correlated subquery keyed on `actor.id` (always current, no staleness). `docs/architecture.md`'s "visibility_filters" is realised as that subquery, not as a materialised list.
- `SystemActor` is for E-phase jobs that legitimately span users. It is still not "unscoped": repo functions handle `kind: 'system'` explicitly (usually: skip the block predicate, keep enforcement, or route to `db/admin`). A worker that needs a true cross-actor read uses `db/admin` and says so.
- Moderator capabilities are **not** an actor field yet — moderation is D4. When it lands it is either a `role` on `UserActor` or a distinct `ModeratorActor`; noted, not built.

**Where it comes from, with no auth:**

1. **The type and `SYSTEM_ACTOR` constant** ship in `db/scope/actor.ts`.
2. **`loadActorByUserId(userId): Promise<UserActor>`** in `db/scope/resolve.ts` — reads exactly `{ id, verification_state, standing }` from `user` for that id (throws if missing). This is a narrow, named data read, not authentication.
3. **Tests** construct `UserActor` literals directly from seeded rows.
4. **B1 later** adds `getSessionActor(request)` that resolves a session cookie → `userId` → `loadActorByUserId`. The `Actor` shape and `loadActorByUserId` do not change; B1 only puts a session in front. This is trust boundary #2: the API resolves *who is acting*, the data layer just consumes the resolved `Actor`.

Repositories depend only on the `Actor` interface — never on how it was produced.

---

## Repository breadth (decided) — `plans` and `users` only

Build `plans` and `users` repositories fully. They prove the pattern and satisfy the "done when". Phase-C tasks build `circles` / `applications` / `threads` / `messages` repositories against this infrastructure. Do **not** write thin stubs for the others — the rule "no unscoped `findMany` outside a named admin module" holds trivially because there are no other repo `findMany`s yet.

---

## Done-when (todo A3) — how it is proven

`tests/integration/repo-block-scoping.test.ts`: seed userA, userB, a circle led by userB, a published plan hosted by it. `plans.feed(actorA, {...})` returns it. Then insert `block(actorA → userB)`. `plans.feed(actorA, {...})` no longer returns it; `plans.feed(actorB, {...})` also no longer returns it (bidirectional). `db/admin` unscoped read still returns it (it exists — it was filtered, not deleted). And: assert `plans.feed(...).toSQL()` contains the `block` `not exists` subquery — the exclusion is in SQL, not a `.filter()` after fetch.

`tests/integration/rls-deny-by-default.test.ts`: a raw `unlisted_app` connection runs `SELECT * FROM plan` with no `app.actor_id` set → 0 rows.

`tests/integration/repo-enforcement-visibility.test.ts`: a plan hosted by a `restricted` (then `suspended`, then `banned`) circle lead is absent from another actor's `plans.feed`, present in the host's own `plans.feed`.

`tests/unit/no-unscoped-query.test.ts`: static scan — no file under `db/` outside `db/client.ts`, `db/scope/`, `db/admin/`, and the test harness imports `pg` / `drizzle-orm/node-postgres`, and no raw `.select(` on a client outside `db/scope/` and `db/admin/`.

`tests/unit/env.test.ts`: Zod env parsing — missing `DATABASE_URL` throws with a clear message; a non-postgres URL is rejected; lazy access does not throw at import.
