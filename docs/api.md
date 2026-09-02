# Unlisted — API Surface

Every endpoint below states its authorization rule. If an endpoint is added without one, it does not ship.

## Conventions

- All identifiers are ULIDs. Never accept or return a sequential ID.
- **No personal data in URLs or query strings**, ever. It lands in logs, proxies, referrer headers, and analytics.
- Errors are generic. `404` for both "does not exist" and "you may not see this" — distinguishing them leaks existence.
- Every state-changing endpoint accepts an idempotency key.
- Every response passes through an explicit view model. Never serialize a domain entity directly.

## Rate limits

Per account and per IP, whichever is stricter. Values are starting points.

| Class | Limit |
|---|---|
| Auth attempts | 5 / 15 min |
| Verification start | 3 / day |
| Plan creation | 5 / day |
| Applications | 20 / day |
| Messages | 60 / hour |
| Reports | 10 / day |
| Reads | 300 / min |

Report limits exist to stop harassment-by-report, not to discourage reporting. Set them high enough that no honest user meets them.

---

## Auth

| Endpoint | Auth | Rule |
|---|---|---|
| `POST /auth/session` | none | Rate limited hard. Generic failure message |
| `DELETE /auth/session` | session | Invalidates server-side |
| `POST /auth/recover` | none | Always returns success regardless of account existence |

Sessions are server-side, httpOnly, `SameSite=Lax`, rotated on privilege change, and revocable individually.

## Verification

| Endpoint | Auth | Rule |
|---|---|---|
| `POST /verification/start` | session | Returns a vendor session. No document ever touches our servers |
| `POST /verification/webhook` | vendor signature | Signature verified before parsing. Sets `verification_state`, `age`, `identity_hash` |

The webhook stores an assertion, never a document. Verify the signature before doing anything with the body.

## Profile

| Endpoint | Auth | Rule |
|---|---|---|
| `GET /me` | session | Self only |
| `PATCH /me` | session | Whitelisted fields only. `standing`, `record`, `signal_score` are not writable by anyone |
| `POST /me/photos` | session, verified | Server-side EXIF strip, content moderation, virus scan before storage |
| `DELETE /me/photos/:id` | session | Owner only |
| `GET /users/:id` | session | **Only if actor shares a plan context with the subject.** Otherwise 404 |

The last rule is the one that prevents a people directory from existing by accident. There is no endpoint that lists users. There is no search over users.

## Circles

| Endpoint | Auth | Rule |
|---|---|---|
| `POST /circles` | session, verified | Creator becomes lead |
| `GET /circles/:id` | session | Members only |
| `POST /circles/:id/members` | session | Lead only. Invitee must accept |
| `DELETE /circles/:id/members/:userId` | session | Lead, or the member removing themselves |
| `POST /circles/:id/lead` | session | Current lead only. Audited |

## Venues

| Endpoint | Auth | Rule |
|---|---|---|
| `GET /venues` | session | Public registry, filterable by district and type |
| `GET /venues/:id` | session | Public data only. `licence_ref` and `capacity_hint` never serialized |

## Plans

| Endpoint | Auth | Rule |
|---|---|---|
| `POST /plans` | session, verified, standing=good | Host circle lead only. Enforces `MIN_HOST_CIRCLE` and `MIN_PLAN_TOTAL` |
| `POST /plans/:id/publish` | session | Lead only. Rejects if member confirmations incomplete |
| `GET /plans` | session | Discovery. Filtered by district, date, blocks, and enforcement visibility |
| `GET /plans/:id` | session | Published plans, or any plan the actor's circle hosts |
| `PATCH /plans/:id` | session | Lead only. Immutable after first invitation: venue, time, and minimums |
| `POST /plans/:id/cancel` | session | Lead only. Notifies all accepted guests |

`GET /plans` must apply the block filter and the enforcement visibility filter in the repository query. Filtering after fetching means the excluded plans were already in memory and one serialization bug away from the client.

## Applications

| Endpoint | Auth | Rule |
|---|---|---|
| `POST /plans/:id/applications` | session, verified, standing=good | Circle lead or solo applicant. Enforces `min_group_size` |
| `POST /applications/:id/confirm` | session | The confirming member only. Confirms a specific version hash |
| `DELETE /applications/:id` | session | Lead, before invitation |
| `POST /applications/:id/withdraw-member` | session | The member themselves. Triggers re-confirmation or invalidation |
| `GET /applications/:id` | session | Applicant members, or host circle lead |

Confirmation binds to a **version hash** of the application. If the lead edits the note or the member set afterwards, prior confirmations are void. Otherwise a lead can submit something nobody agreed to.

## Review

| Endpoint | Auth | Rule |
|---|---|---|
| `GET /plans/:id/applications` | session | Host circle lead only |
| `POST /applications/:id/shortlist` | session | Host circle lead. Reversible |
| `POST /applications/:id/reject` | session | Host circle lead. Applicant sees a neutral outcome, never a reason |
| `POST /applications/:id/invite` | session | Host circle lead. Whole circle or selected members. Capacity-checked under a row lock |

Partial invitation returns the affected circle to `Awaiting confirmation`. Nobody is invited into a smaller group than they agreed to without re-consenting.

## Invitations

| Endpoint | Auth | Rule |
|---|---|---|
| `POST /invitations/:id/accept` | session | Invitee only. Locks the plan row. Rejects on overlap with another accepted plan |
| `POST /invitations/:id/decline` | session | Invitee only |

Both are idempotent. A double-tap must not produce two acceptances.

## Assembly

| Endpoint | Auth | Rule |
|---|---|---|
| `POST /plans/:id/assembly/join` | session, verified | Adds the actor to the solo pool |
| `POST /assemblies/:id/confirm` | session | Proposed member only |
| `DELETE /assemblies/:id/leave` | session | Self only |

A dissolved assembly notifies members that the plan did not come together. It never says who declined.

## Messages

| Endpoint | Auth | Rule |
|---|---|---|
| `GET /plans/:id/thread` | session | Members of both circles, after invitation |
| `POST /plans/:id/thread` | session | Same. Rate limited |

**There is no endpoint that creates a thread between two users.** The route does not exist, the schema cannot represent it, and no parameter combination produces one.

## Safety

| Endpoint | Auth | Rule |
|---|---|---|
| `POST /reports` | session | Any actor about any user they share a plan context with |
| `POST /blocks` | session | Immediate bidirectional effect |
| `DELETE /blocks/:id` | session | Blocker only |
| `POST /plans/:id/feedback` | session | Attendees only, after the plan. One per attendee |
| `POST /support/urgent` | session | During an event window. Routes to on-call, not a queue |

Reports never notify the subject. Blocks never notify the blocked party.

## Moderation

All endpoints require `moderator` and are audited without exception.

| Endpoint | Rule |
|---|---|
| `GET /mod/queue` | Signals grouped by subject, ordered by pattern weight |
| `GET /mod/cases/:id` | Evidence view. Access logged with the reason |
| `POST /mod/actions` | Restrict, suspend, ban, revoke hosting. Requires a written reason |
| `POST /mod/appeals/:id` | Reviewed by a different moderator than the one who acted |

Moderator access to a user's data is logged per access with a stated reason. Insider misuse is the most likely serious privacy failure and the least likely to be noticed without this.

## Webhooks and inbound

Every inbound webhook verifies its signature before parsing the body. No inbound endpoint accepts a URL parameter that the server will then fetch.
