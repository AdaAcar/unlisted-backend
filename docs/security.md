# Unlisted — Security

Physical safety lives in `safety.md`. This document covers the system.

## What an attacker wants here

Not money. This platform holds verified identities, faces, real first names, and a schedule of where specific people will physically be on a specific night. That last item is the crown jewel and it has no equivalent in most consumer products.

Threat actors, in rough order of likelihood:

1. **A user enumerating other users** to build a directory, scrape faces, or find one specific person.
2. **A banned user returning** under a new account.
3. **A stalker** using the platform to locate someone who is avoiding them.
4. **An insider** — a moderator or engineer browsing profiles.
5. **A scraper** harvesting the plan feed for a competing product or a dataset.
6. **Ordinary web attack surface** — account takeover, IDOR, injection, SSRF.

Control 3 first. A product that tells a stalker where their target will be at 22:00 on Saturday has failed in a way no other bug matches.

---

## Layer: client

The client is a rendering surface with no authority.

- No authorization logic in the browser. Hiding a button is presentation.
- No secrets in the bundle. Audit `NEXT_PUBLIC_*` as a routine check.
- Strict CSP with nonces. No `unsafe-inline`, no `unsafe-eval`.
- `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` denying geolocation, camera, and microphone unless a feature needs them.
- No personal data in `localStorage` or `sessionStorage`.
- Server Components fetch only what the actor may see. A component must not receive a full entity and render a subset — the unrendered fields are still in the payload.
- **Open Graph and meta tags never contain plan specifics.** A shared link preview that shows venue and time leaks an attendee's whereabouts to anyone the link reaches.

## Layer: edge

- Rate limits per account and per IP. See `api.md`.
- Bot detection on registration and on the plan feed.
- Aggressive limits on any endpoint that could enumerate: profile reads, plan reads, application reads.
- Block datacenter ranges on the discovery feed unless a legitimate need appears.

## Layer: API

- **Schema validation on every input.** Parse, then use the parsed value. Never the raw body.
- **404 rather than 403** for resources the actor may not see. Distinguishing the two leaks existence, which is exactly what a stalker needs.
- Idempotency keys on all state-changing routes.
- No user-supplied URL is ever fetched server-side. This closes SSRF, which is the usual path to cloud metadata.
- Uploads: server-side content-type detection rather than trusting the header, size caps, virus scan, and re-encode.
- **EXIF stripping on every uploaded image, server-side, before storage.** Phone photos carry GPS coordinates. A profile photo taken at home is a home address. This single line is one of the highest-value controls in the entire document.

## Layer: authorization

One module, three inputs, no exceptions. Covered in `architecture.md`; the security-relevant properties:

- Deny by default. An action with no matching rule is denied.
- Block and enforcement filters apply in the **repository query**, not after fetching. Post-fetch filtering means the data was already in memory.
- Every endpoint has an integration test asserting the deny path, not only the allow path.

## Layer: data

- Postgres row-level security as defence in depth, on the assumption the application layer will eventually have a bug.
- `identity_hash` and `verification_ref` encrypted at rest with a separate key and separate access control. Application code that does not need them cannot read them.
- No date of birth stored. The vendor asserts 18+ and returns an age.
- Backups encrypted, restores tested, and restore access audited.
- **Production data never leaves production.** Development and staging run on synthetic seed data. There is no sanitised-export path, because sanitisation always misses a field and the existence of the path is itself the risk.

## Layer: logs, notifications, analytics

The quietest leak and the most common.

- Structured logs with PII scrubbing at the emitter, not in a downstream processor.
- Never log: full names, photo URLs, plan-attendee pairings, message bodies, verification references.
- **Notification bodies are redacted.** "You have an update on a plan" rather than the venue, time, and who invited you. A lock-screen preview is visible to whoever is holding the phone, which may be the person the user is avoiding.
- Analytics receives event names and coarse dimensions. Never a user's plan history.
- Error tracking scrubs request bodies by default, with an allowlist rather than a denylist.

## Layer: third parties

Each gets the minimum payload and a documented data-processing basis.

| Vendor | Receives | Never receives |
|---|---|---|
| KYC | Document, directly from the user's device | Anything about plans or other users |
| Object storage | Images, private bucket, signed URLs, short TTL | Metadata linking image to plan |
| Mail and push | Redacted bodies | Venue, time, attendee names |
| Analytics | Event names, coarse dimensions | Any identifier that resolves to a person |

## Specific attacks and their answers

**Enumeration.** ULIDs, no user list endpoint, no user search, profile visibility gated on shared plan context, hard read limits. Accept that a determined scraper can still harvest the plan feed; limit the blast radius by keeping attendee lists out of it.

**Ban evasion.** Bans attach to `identity_hash`, so a new account with the same verified identity is caught at verification. Supplement with device and payment signals. This is the main reason identity verification is worth its cost — screening is not.

**Stalking.** The highest-severity scenario. Blocks are bidirectional, hide rather than prevent, and are applied in the query layer. Notifications are redacted. There is no user search. There is no way to ask "which plans is this person attending." A block placed before an application must also remove that person from any shared plan already in flight, and that path needs an explicit test.

**Account takeover.** Server-side sessions, rotation on privilege change, individual revocation, second factor before any change to verification or standing, and re-authentication before sensitive actions.

**Insider access.** Moderator reads are logged per access with a stated reason. Engineer access to production is broken-glass, time-boxed, and alerted. Assume this is the most likely path to a serious privacy failure, because it usually is.

**Capacity race.** Row lock on the plan inside the accepting transaction. Not a read-then-write.

**Harassment by report.** Report limits set high enough that no honest user meets them. Weight by reporter history. Never surface the reporter.

## Compliance, Türkiye

- Register as data controller and complete VERBİS obligations.
- Identity verification data is special-category and requires explicit, separable consent with a documented lawful basis.
- Written retention schedule per data class, implemented as a worker rather than a policy nobody runs.
- Data subject rights: access, export, erasure. Erasure and ban durability conflict on `identity_hash` — document the legal basis before launch.
- Breach notification path and timeline decided in advance.
- A named data protection contact.

## Pre-launch checklist

- [ ] Every endpoint has a written authorization rule and a passing deny-path test
- [ ] EXIF stripping verified with a GPS-tagged test image
- [ ] Block tested bidirectionally, including a block placed mid-flight on a shared plan
- [ ] Notification bodies reviewed on a locked phone screen
- [ ] No `NEXT_PUBLIC_*` variable contains anything sensitive
- [ ] Staging confirmed to hold zero production rows
- [ ] Log sample audited for PII
- [ ] Ban evasion tested end to end with a real re-verification
- [ ] Capacity race tested under concurrent accepts
- [ ] Retention workers running and verified
- [ ] External penetration test on the authorization layer
