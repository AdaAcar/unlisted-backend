# Unlisted — Architecture

## Layers

```text
Client            Next.js App Router, React Server Components
                  Never holds authorization logic. Never trusted.
------------------------------------------------------------ trust boundary
Edge              Rate limiting, bot detection, CSP, WAF
API               Route handlers and server actions. Input validation.
                  Authentication resolved here, once, per request.
Authorization     Single policy module. Every read and write passes it.
Domain            Circles, plans, applications, invitations, assembly,
                  signals. All invariants and state machines live here.
Data              Postgres. Repository layer scoped by actor.
                  Object storage for images. Redis for limits and locks.
Workers           Deadlines, expiry, notifications, retention jobs,
                  pattern detection.
```

The only rule that matters: **the client is an untrusted rendering surface.** Every constraint in `product.md` — minimum group sizes, no individual messaging, no directory, capacity, state transitions — is enforced in the domain layer and re-checked at the data layer. The UI hiding a button is presentation, never protection.

## Stack

| Concern | Choice | Note |
|---|---|---|
| Framework | Next.js App Router | Already in the prototype |
| Language | TypeScript, strict | No `any` in domain code |
| Database | Postgres | Row-level security as defence in depth |
| ORM | Prisma or Drizzle | Repository wrapper either way |
| Auth | Auth.js or a managed provider | Sessions server-side, httpOnly, rotating |
| Identity verification | Third-party KYC vendor | See `security.md` for data handling |
| Object storage | S3-compatible, private buckets | Signed URLs, short TTL |
| Cache and limits | Redis | Rate limits, idempotency, distributed locks |
| Queue | Postgres-backed or Redis-backed | Deadlines, notifications, retention |
| Mail and push | Transactional provider | Redacted content, see `security.md` |
| Monitoring | Error tracking + structured logs | PII scrubbing at source |

Substitutable. The layering is not.

## Trust boundaries

There are four, and each needs an explicit check.

1. **Client to API.** Everything from the browser is hostile input. Validate shape with a schema, then validate meaning in the domain.
2. **API to domain.** The API layer resolves *who is acting*. The domain decides *what they may do*. These are separate; conflating them is how IDOR bugs happen.
3. **Domain to data.** The repository layer takes an actor and scopes every query. There is no unscoped `findMany` outside admin tooling.
4. **Platform to third parties.** KYC vendor, storage, mail, analytics. Each gets the minimum payload. None gets venue-adjacent or contact data it does not need.

## Request path

```text
Request
  -> Edge: rate limit by IP + account, bot check
  -> Auth: resolve session, load actor (id, verification state, standing)
  -> Validate: schema parse, reject on failure with no detail leakage
  -> Authorize: policy(actor, action, resource) -> allow | deny
  -> Domain: invariants, state machine, capacity, min-group rules
  -> Data: actor-scoped repository call inside a transaction
  -> Audit: append entry for any state-changing action
  -> Response: serialize through a view model, never the raw row
```

The **view model** step is not optional. Domain entities carry fields that must never reach a client — verification references, internal standing scores, signal counts, moderator notes. Serialization goes through an explicit per-audience mapper, so adding a field to an entity cannot silently expose it.

## Authorization model

One module. Three inputs: actor, action, resource. No authorization decisions anywhere else in the codebase.

Actor states that affect every decision:

- `verified` — completed identity verification
- `standing` — `good` | `restricted` | `suspended` | `banned`
- `visibility_filters` — the set of users and circles this actor must never see or be seen by

Resource-level rules are enumerated in `api.md`. Two that are easy to get wrong:

- **Blocking is bidirectional and hides rather than prevents.** A blocked pair must not see each other's plans, applications, or profiles, and neither is told why. This is a query-layer filter, not a UI condition.
- **Silent enforcement.** A restricted actor's plans and applications are simply not surfaced to affected parties. The actor is not notified. This is applied in the repository scope so it cannot be bypassed by an endpoint that forgot.

## Domain invariants

Enforced in the domain layer, mirrored as database constraints where expressible.

- A plan cannot publish below `MIN_HOST_CIRCLE` confirmed members.
- An application cannot submit while any included member is unconfirmed.
- Accepted count never exceeds open spots. Enforced with a row lock on the plan, not an application-level read-then-write.
- No user holds two accepted invitations for overlapping time windows.
- No plan may have a total capacity below `MIN_PLAN_TOTAL`.
- No message thread may exist between exactly two individuals.
- A state transition not present in the machine is rejected, not coerced.

## Concurrency

Two host-circle leads reviewing simultaneously is the common race, and overbooking is the consequence. Use a row-level lock on the plan for any capacity-affecting transition, inside a transaction. Idempotency keys on invite, accept, and decline so a double-tap or a retried request cannot double-apply.

## Workers

- **Deadlines** — expire applications, invitations, and plans on schedule.
- **Assembly** — form circles from the solo pool before a plan's cutoff.
- **Notifications** — with delivery status and retry, and redacted bodies.
- **Retention** — delete verification artefacts, expired signals, and inactive-account data on schedule.
- **Pattern detection** — co-occurrence and non-return analysis for enforcement, run offline, never in the request path.

## Environments

Three, with a hard rule: **production data never leaves production.** Staging and development run on synthetic data generated by a seed script. There is no "sanitised export" path, because sanitisation always misses something and the temptation to use one is where breaches start.

## Testing

- Unit: state machines, capacity, minimum-group rules, assembly
- Integration: authorization for every endpoint, both allow and deny paths
- End-to-end: post a plan, apply as circle, apply as solo, assembly, review, invite, accept, decline, block, report
- Adversarial: IDOR attempts across every resource, capacity races, ban evasion, and every enforced format constraint attacked directly

An authorization test that only asserts the happy path is worse than none, because it produces confidence without coverage.
