# Unlisted — backend

Group-to-group social app. Someone posts a plan at a public venue with open spots; other people and groups apply; the poster decides who joins. **No plan ever becomes a meeting between two people** — enforced structurally by the viability rule (see `docs/agent-rules.md`).

This repo is the **backend only**: route handlers, domain logic, data layer, and tests. No UI.

## Stack

- Next.js App Router (route handlers under `app/api`)
- TypeScript, `strict: true`
- Postgres via Drizzle ORM
- Zod for input validation
- Vitest for tests

## Getting started

```bash
pnpm install
pnpm db:up      # postgres:16 via docker compose, localhost:5433
```

Create `.env.local` (git-ignored):

```
DATABASE_URL=postgres://unlisted:unlisted@localhost:5433/unlisted_test
TEST_DATABASE_URL=postgres://unlisted:unlisted@localhost:5433/unlisted_test
AUDIT_HASH_SECRET=<32+ bytes>
IDENTITY_HASH_SECRET=<32+ bytes>
VERIFICATION_WEBHOOK_SECRET=<32+ bytes>
```

```bash
pnpm test        # unit + integration, fails loudly if TEST_DATABASE_URL is unset
pnpm typecheck
pnpm lint
pnpm dev
```

## Repo layout

```text
app/api/    Route handlers — thin, delegate to domain/policy/db
domain/     Entities, state machines, invariants (no DB imports)
policy/     Single authorization module
db/         Drizzle schema, migrations, repositories
views/      View models returned to clients
workers/    Scheduled jobs
lib/        Config, validation, ULID, rate limiting
tests/      unit/ integration/ adversarial/
docs/       Specs — read before touching anything
```

## Where to start reading

1. [`docs/agent-rules.md`](docs/agent-rules.md) — governs all work in this repo, read first
2. [`docs/state.md`](docs/state.md) — current status, decisions made, known gaps
3. [`todo_agent.md`](todo_agent.md) — task list
