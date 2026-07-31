# Backend stories — BE-01 … BE-10

> **Status: all ten are done and on `main`,** each through its own pull
> request. This document is kept as the record of what each story was judged
> against; the reasoning behind each implementation is in the PR that
> delivered it.
>
> Three of them grew in the building, and the PRs say so:
>
> - **BE-01** shipped a bug and caught it before merge. The first version
>   passed all twelve tests while the *logs* showed reuse detection firing
>   during the concurrency test — four concurrent losers each revoked the
>   token family, destroying the winner's fresh token. Two browser tabs would
>   have logged the user out.
> - **BE-06** did not meet its 100 ms acceptance criterion for two queries and
>   says so rather than moving the goalposts, along with why a rollup is the
>   real answer.
> - **BE-10** needed a fourth required CSV column the story did not
>   anticipate: `Conversion.trackingLinkId` is `NOT NULL`, and an imported row
>   has no clicks to resolve it from.

Ten stories chosen for what they *teach*, not for what a user would notice.
Every one of them is a real gap in this codebase, and several are latent bugs
that only appear under load, under concurrency, or on the second server —
which is exactly the class of problem that separates a backend engineer from
someone who can make an endpoint return 200.

**Read [01-app-overview.md](./01-app-overview.md) first,** and skim
[02-user-stories.md](./02-user-stories.md) for the conventions. Everything in
the "Definition of done" there still applies.

## What these are for

The first twenty stories built features. These ten build *judgement about
failure*. Each one is framed around a question you will be asked in a design
review or an interview, and the answer is meant to come from having done it:

| # | Story | Size | The question it teaches you to answer |
| --- | --- | --- | --- |
| BE-01 | Refresh token rotation + reuse detection | M | "A token leaks. How do you find out?" |
| BE-02 | Idempotency as reusable middleware | M | "The client retried. Did it charge twice?" |
| BE-03 | Poison-message resilience in the click worker | M | "One bad message. How many good ones die with it?" |
| BE-04 | Cursor pagination | M | "Page 5,000 is slow and rows repeat. Why both?" |
| BE-05 | Outbound webhooks with backoff + circuit breaker | L | "Their endpoint is down. What happens to yours?" |
| BE-06 | Query plans, indexes and the N+1 | L | "It's slow. Where, and how do you know?" |
| BE-07 | Distributed scheduling with leader election | M | "You scaled to two instances. What ran twice?" |
| BE-08 | Correlation IDs and RED metrics | M | "A user reports a slow request. Trace it." |
| BE-09 | Per-key rate limiting with a token bucket | M | "Who is allowed how much, and where is that counted?" |
| BE-10 | Bulk conversion import, streamed | L | "Row 40,000 of 50,000 is invalid. Now what?" |

**Suggested order:** BE-01 → BE-02 → BE-03 → BE-07 → BE-09 → BE-04 → BE-08 →
BE-06 → BE-05 → BE-10. Later ones lean on earlier ones; the dependency column
in each story says which.

## Definition of done (in addition to the one in 02)

1. **Every story ships a test that fails against the old code.** If you cannot
   write one, you have not understood the bug yet — that is the signal to stop
   and re-read, not to skip the test.
2. **Concurrency claims are proven with concurrent tests,** not asserted in a
   comment. `Promise.all` of N requests, then assert the invariant.
3. **Anything you claim is faster gets a number** in the PR description, from
   `EXPLAIN ANALYZE` or a timed benchmark.
4. **New failure modes get a log line with enough context to act on** — an id,
   a count, a reason. `logger.error({ err }, 'failed')` is not enough.

---

# BE-01 — Refresh token rotation with reuse detection

**Size** M · **Depends on** — · **Priority** highest

**As a** platform operator
**I want** refresh tokens to be single-use and to detect when an old one is
replayed
**so that** a stolen token is both time-limited and *detectable*, instead of
granting an attacker indefinite access that nobody ever notices.

### Context

`apps/api/src/services/auth.service.ts:31` signs a stateless refresh token
carrying `{ id, tokenVersion, type: 'refresh' }`. Refreshing verifies the
signature and issues a new access token — but **the refresh token itself never
changes and is never recorded**. Three consequences:

1. A token captured once works until it expires (`JWT_REFRESH_TTL`, 30 days by
   default). Using it leaves no trace.
2. The only revocation lever is `tokenVersion`, which invalidates *every*
   session the user has. Logging out one device logs out all of them.
3. There is no way to answer "is this token being used by two parties?"

The web client keeps the token in `localStorage` (see the comment at the top of
`apps/web/src/lib/api.ts`), which was a documented, deliberate deferral. This
story does not change that decision — it makes the decision survivable, which
is the more important half and the half that is missing.

### The concept: token families

Rotation alone is not enough. If every refresh mints a new token and invalidates
the old one, an attacker who steals a token races the legitimate user — whoever
uses it first wins, and the loser is silently logged out. That is not
detection, it is a coin flip.

The standard answer (RFC 6819 §5.2.2.3, and OAuth 2.1 §6.1) is to keep a
**family**: every rotation records the new token as a child of the one it
replaced. When a token that has *already been rotated* is presented, that is
proof of duplication — one of the two parties is an attacker, and you cannot
tell which. So you revoke the entire family and force a real login.

```text
login ──► T1 ──rotate──► T2 ──rotate──► T3        (legitimate device)
                 │
                 └── attacker replays T1 ──► T1 is already rotated
                                             ⇒ revoke family, T3 dies too
```

### Acceptance criteria

1. A new `RefreshToken` model persists **a SHA-256 hash** of each issued token,
   never the token itself. (If your database leaks, hashes are useless to an
   attacker; raw tokens are session cookies.)
2. `POST /api/auth/refresh` rotates: the presented token is marked
   `rotatedAt = now()`, and a new token is issued in the same family
   (`familyId` carried over).
3. Presenting a token whose `rotatedAt` is **not null** revokes every token in
   that family, returns `401` with code `TOKEN_REUSE_DETECTED`, and logs at
   `warn` with `familyId`, `userId`, and the age of the reused token.
4. Presenting a token belonging to a revoked family returns `401`.
5. `POST /api/auth/logout` revokes **only the presenting family**, not every
   session. A second logged-in device stays logged in.
6. A new `POST /api/auth/logout-all` revokes every family for the user, and
   *that* is what bumps `tokenVersion`.
7. `GET /api/auth/sessions` lists the user's active families with
   `createdAt`, `lastUsedAt`, `userAgent` and `ipHash`, so a user can see where
   they are logged in. Each row can be revoked individually by id.
8. Rotation is safe under concurrency: two simultaneous refreshes with the
   *same* token produce exactly one success and one `401`, never two valid
   tokens. (This is the same check-then-act shape as US-07 and the reversal bug
   — see the PR for #24. Use a conditional claim.)
9. Expired and revoked rows older than 30 days are deleted by a cleanup job, so
   the table does not grow without bound.

### Schema

```prisma
model RefreshToken {
  id         String    @id @default(cuid())
  familyId   String
  tokenHash  String    @unique          // sha256 of the raw token
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  issuedAt   DateTime  @default(now())
  expiresAt  DateTime
  rotatedAt  DateTime?                  // set when this token mints its successor
  revokedAt  DateTime?
  userAgent  String?
  ipHash     String?

  @@index([familyId])
  @@index([userId, revokedAt])
  @@index([expiresAt])
}
```

`tokenHash` is unique so a duplicate insert is a database error rather than a
silent second row.

### API contract

```http
POST /api/auth/refresh
{ "refreshToken": "<token>" }
  → 200 { accessToken, refreshToken }        # a NEW refresh token, every time
  → 401 { error: { code: "TOKEN_REUSE_DETECTED" } }
  → 401 { error: { code: "INVALID_REFRESH_TOKEN" } }

GET  /api/auth/sessions          → 200 [{ id, createdAt, lastUsedAt, userAgent, current }]
POST /api/auth/sessions/:id/revoke → 204
POST /api/auth/logout            → 204   # this family only
POST /api/auth/logout-all        → 204   # every family + tokenVersion bump
```

### Files to touch

- `apps/api/prisma/schema.prisma` + a migration.
- `apps/api/src/repositories/refresh-token.repository.ts` *(new)*.
- `apps/api/src/services/auth.service.ts` — rotation, reuse detection,
  family revocation.
- `apps/api/src/routes/auth.routes.ts` — the four new/changed endpoints.
- `apps/web/src/lib/api.ts` — store the rotated token the refresh returns.
  **This is the easy step to forget:** if the client keeps using the old token
  after a refresh, it will trip reuse detection and log itself out. Write that
  test.
- `apps/api/src/workers/` — a cleanup pass (see BE-07 before you add another
  `setInterval`).

### Tests

- Rotation returns a *different* refresh token; the old one is then rejected.
- Replaying a rotated token revokes the family: a token issued *after* it also
  stops working.
- Concurrency: `Promise.all` of 5 refreshes with the same token → exactly one
  `200`.
- Logout on device A leaves device B working; `logout-all` kills both.
- The session list shows two rows for two logins and one after a revoke.

### Trade-offs to write up in the PR

Stateful refresh tokens cost a database round-trip on every refresh and a table
that grows. Say what you are buying with that: revocation that actually works,
and detection you cannot get from a stateless token. Also say what you did
*not* do — the token still lives in `localStorage`, and this story does not
change that.

---

# BE-02 — Idempotency as reusable middleware

**Size** M · **Depends on** BE-01 (for the concurrency pattern) · **Priority** high

**As an** API client
**I want** to retry any mutating request safely
**so that** a timeout or a network blip does not create a second payout, a
second campaign, or a second conversion.

### Context

Exactly one endpoint is idempotent today: `POST /api/affiliate/payouts` reads an
`Idempotency-Key` header (`apps/api/src/routes/payout.routes.ts:58`) and relies
on a `@@unique([affiliateId, idempotencyKey])` constraint. That works, but:

- It is bespoke — every new endpoint that needs it re-implements it.
- It returns the *existing row*, not the *original response*. If the first call
  returned `201` with a body, the retry returns `200` with a possibly different
  shape.
- It does not handle a retry that arrives **while the first is still running**.
  Two concurrent requests with the same key both miss the row, both proceed,
  and one loses on the constraint with a 500-shaped error.

Every other mutating endpoint — conversion reporting is the one that matters
most, since brands' servers retry on timeout — has nothing.

### The concept

An idempotency key turns "at least once" delivery into "effectively once"
processing. The mechanism is a store keyed by `(key, endpoint)` holding a state
machine:

```text
              ┌──────────────┐
  first call  │ IN_PROGRESS  │  concurrent retry ──► 409 IDEMPOTENT_REQUEST_IN_FLIGHT
  ───────────►│              │
              └──────┬───────┘
                     │ handler returns
                     ▼
              ┌──────────────┐
              │  COMPLETED   │  later retry ──► replay stored status + body
              │ (status,body)│
              └──────────────┘
```

Two details that are easy to get wrong and are the point of the story:

- **Fingerprint the request body.** The same key with a *different* body is a
  client bug, and silently replaying the first response hides it. Return `422`
  with code `IDEMPOTENCY_KEY_REUSED`.
- **Only cache what succeeded.** A `5xx` should not be replayed — the client is
  retrying precisely because it wants a different outcome. A `4xx` is a
  deterministic client error and *is* worth caching. Decide, and say why.

### Acceptance criteria

1. A Fastify plugin `idempotency` is applied per-route via route config, not
   globally. `GET` and `DELETE` are never affected.
2. On a request with `Idempotency-Key`, the middleware claims the key
   atomically (insert; unique-constraint violation means someone else has it).
3. A retry after completion replays the stored **status code and body** byte
   for byte, and sets a response header `Idempotent-Replay: true`.
4. A retry while in flight gets `409 IDEMPOTENT_REQUEST_IN_FLIGHT` with a
   `Retry-After: 1` header.
5. Same key + different body fingerprint → `422 IDEMPOTENCY_KEY_REUSED`.
6. Responses with status ≥ 500 are **not** stored; the key is released so a
   retry can genuinely retry.
7. Keys expire after 24 hours and are swept.
8. Applied to at least: `POST /api/conversions/:campaignId`,
   `POST /api/affiliate/payouts` (replacing the bespoke logic),
   `POST /api/brand/campaigns`.
9. The existing payout idempotency tests still pass unchanged. If you have to
   edit them, you have changed behaviour — say so in the PR.

### Schema

```prisma
model IdempotencyKey {
  id           String   @id @default(cuid())
  key          String
  endpoint     String                       // method + route pattern
  userId       String?
  fingerprint  String                       // sha256 of the canonical body
  status       IdempotencyStatus @default(IN_PROGRESS)
  responseCode Int?
  responseBody Json?
  createdAt    DateTime @default(now())
  expiresAt    DateTime

  @@unique([key, endpoint])
  @@index([expiresAt])
}
```

### Files to touch

- `apps/api/src/plugins/idempotency.ts` *(new)* — the plugin.
- `apps/api/src/lib/fingerprint.ts` *(new)* — canonical JSON (sorted keys) then
  SHA-256. Unit-test that `{a:1,b:2}` and `{b:2,a:1}` fingerprint identically.
- `apps/api/src/routes/conversion.routes.ts`, `payout.routes.ts`,
  `campaign.routes.ts`.
- `apps/api/src/services/payout.service.ts` — delete the bespoke path.

### Tests

- Same key twice → one row created, second response is a byte-identical replay
  with `Idempotent-Replay: true`.
- `Promise.all` of 10 identical conversion postbacks → **one** conversion, nine
  `409`s or replays, and never two.
- Different body, same key → `422`.
- A handler that throws a 500 → key released, retry actually re-runs.
- No `Idempotency-Key` header → completely unaffected.

---

# BE-03 — Poison-message resilience in the click worker

**Size** M · **Depends on** — · **Priority** high

**As an** operator
**I want** one malformed click event to cost me one click event
**so that** a single bad producer cannot silently destroy 99 good rows on every
batch.

### Context

`drainClickEvents` (`apps/api/src/workers/click-event.worker.ts:48`) pops up to
100 events and writes them in **one transaction**. Malformed *JSON* is handled —
it is logged and dropped. But an event that parses as JSON and is still invalid
(missing `trackingLinkId`, a `trackingLinkId` that violates the foreign key, a
`timestamp` that is not a date) throws inside `flushBatch`, the whole
transaction rolls back, and **all 100 events go to the DLQ**.

The DLQ was added in US-17 and is genuinely better than losing them. But
`replayDeadLetters` puts them straight back on the main queue, where the same
poison event fails the same batch again. One bad row can hold up the pipeline
indefinitely, and 99 good rows are stuck behind it every pass.

There is also no schema validation at all: `JSON.parse(raw)` is cast straight to
`ClickEventPayload`. The type is a lie the moment anything else writes to that
Redis list — which is precisely the argument the existing comment at line 121
makes about sub-ID caps, applied inconsistently.

### The concept: validate per message, then bisect

Two independent mechanisms, and the story is about knowing which does what:

- **Per-message validation** catches everything knowable *without the database*
  — shape, types, ranges. Cheap, and it should happen before the transaction.
- **Bisection** catches what is only knowable *from the database* — a foreign
  key that does not resolve, a unique violation. You cannot predict these, so
  when a batch fails you split it in half and retry each half, recursing until
  the failure is isolated to a single message.

```text
[100 events] ✗
     ├── [50] ✓ committed
     └── [50] ✗
           ├── [25] ✓ committed
           └── [25] ✗ … ⇒ 1 poison event to the DLQ, 99 written
```

That is `O(log n)` transactions to isolate one bad message, instead of `O(n)`
one-at-a-time writes on every batch.

### Acceptance criteria

1. A Zod schema `clickEventPayloadSchema` in `packages/shared` validates every
   message after `JSON.parse`. Failures go to the DLQ with a reason — **not**
   dropped, because unlike malformed JSON a schema failure may be a bug in our
   own producer that we need to see.
2. `flushBatch` failure triggers bisection down to a single message.
3. A batch containing exactly one poison message commits the other 99 and
   DLQs one. Prove it with a test.
4. DLQ entries are JSON envelopes, not bare payloads:
   `{ payload, reason, attempts, firstFailedAt, lastFailedAt }`.
5. `replayDeadLetters` increments `attempts`; a message that has failed
   **3 times** is moved to `click_events_parked` and left alone. An operator is
   told, in a log line, how many are parked.
6. `GET /api/admin/system/queues` reports depths for all three lists, and the
   admin health page shows them.
7. Bisection is bounded: a batch of 1 that fails goes straight to the DLQ, no
   infinite recursion.
8. The happy path costs **exactly one** transaction. Do not let the retry
   machinery slow down the 99.9% case — assert the transaction count in a test.

### Files to touch

- `packages/shared/src/schemas/click-event.schemas.ts` *(new)*.
- `apps/api/src/workers/click-event.worker.ts` — validation, `flushWithBisect`.
- `packages/analytics/src/bisect.ts` *(new)* — the pure splitting logic, unit
  tested independently of Redis and Postgres. This is the piece worth having as
  a pure function: it makes the recursion testable without a database.
- `apps/api/src/services/system.service.ts` + `admin.routes.ts`.

### Tests

- Unit: `bisect` over a synthetic "fails if it contains item X" predicate
  isolates X in `⌈log₂ n⌉` calls.
- Integration: 100 events, one with a `trackingLinkId` that does not exist →
  99 `ClickEvent` rows, 1 DLQ entry, `clickCount` incremented by 99.
- A message failing schema validation never reaches Postgres.
- A DLQ message replayed 3 times ends up parked.
- Happy path: one transaction, no bisection (spy on `$transaction`).

---

# BE-04 — Cursor-based pagination

**Size** M · **Depends on** — · **Priority** medium

**As an** API consumer paging through conversions
**I want** pages that stay correct while new rows arrive
**so that** I neither miss rows nor see the same row twice, and page 5,000 is
as fast as page 1.

### Context

Every list endpoint uses `page`/`pageSize` with Prisma `skip`/`take` — see
`paginationSchema` in `apps/api/src/routes/payout.routes.ts:7`, repeated in at
least four route files. Two distinct problems, and a junior engineer usually
knows only the second:

**Correctness.** Conversions are ordered `occurredAt desc`. Between fetching
page 1 and page 2, three new conversions arrive. They land at the top, shifting
everything down by three — so rows 18, 19 and 20 from page 1 appear *again* on
page 2. Under deletion, rows are skipped entirely and never seen. Any client
doing "page through everything and sum it" gets a wrong number, silently.

**Cost.** `OFFSET 100000` makes Postgres produce and discard 100,000 rows. The
query gets linearly slower as you page, and the slowest queries are the ones
some poor script runs most.

Ordering is also not fully deterministic: `occurredAt` is not unique, so two
conversions in the same millisecond can swap places between requests. That is
the hidden precondition for keyset pagination and worth calling out.

### The concept: keyset (seek) pagination

Instead of "skip 100,000 rows", say "give me rows *after this specific row*":

```sql
-- offset:  plans a full scan-and-discard
SELECT * FROM "Conversion" ORDER BY "occurredAt" DESC OFFSET 100000 LIMIT 20;

-- keyset:  an index seek, same cost on page 1 and page 5000
SELECT * FROM "Conversion"
WHERE ("occurredAt", id) < ($1, $2)      -- row-value comparison
ORDER BY "occurredAt" DESC, id DESC
LIMIT 20;
```

The `(occurredAt, id)` tuple is a **total order** — `id` breaks ties, so the
sort is deterministic and no row can be ambiguous. Postgres compares row values
lexicographically, which is exactly the semantics you want and is why this is
one condition rather than the `(a < x) OR (a = x AND b < y)` sprawl.

### Acceptance criteria

1. A shared cursor helper encodes `{ occurredAt, id }` (or the relevant sort
   key) as an **opaque** base64url string. Opaque matters: clients must not
   construct them, or you can never change the sort key.
2. A tampered or undecodable cursor → `400 INVALID_CURSOR`, never a 500.
3. Responses: `{ data: [...], nextCursor: string | null, hasMore: boolean }`.
   `nextCursor` is `null` on the last page — clients should not have to compare
   lengths to `pageSize` to find out.
4. Applied to `GET /api/brand/conversions`, `GET /api/affiliate/conversions`,
   `GET /api/affiliate/payouts`, `GET /api/admin/payouts`.
5. Every paginated query has a supporting composite index matching the exact
   `ORDER BY`, including direction. Show the `EXPLAIN` in the PR.
6. Offset pagination stays available on the same endpoints for one release,
   behind the existing `page` parameter, and is documented as deprecated. Do
   not break the web client in the same PR that changes the API — say why in
   the description.
7. A test inserts rows *between* two page fetches and asserts no duplicate and
   no missing id. This is the test that justifies the whole story.

### Files to touch

- `packages/shared/src/pagination.ts` *(new)* — `encodeCursor`, `decodeCursor`,
  `CursorPage<T>`. Pure, unit tested.
- The four route files and their services.
- `apps/api/prisma/schema.prisma` — composite indexes, e.g.
  `@@index([affiliateId, occurredAt, id])`.
- `apps/web/src/lib/api.ts` — TanStack Query `useInfiniteQuery` uses
  `nextCursor` directly, which is what it was designed for.

### Tests

- Unit: round-trip encode/decode; a mutated cursor throws.
- Paging the whole set yields every id exactly once.
- Insert 5 rows between page 1 and page 2 → still no duplicates, no gaps.
- `nextCursor` is null exactly on the final page.
- Benchmark in the PR: page 1 vs page 500, offset vs cursor, with numbers.

---

# BE-05 — Outbound webhooks with backoff and a circuit breaker

**Size** L · **Depends on** BE-03 (retry vocabulary) · **Priority** medium

**As a** brand
**I want** the platform to POST to my endpoint when a conversion is approved,
reversed, or a payout completes
**so that** I can react in my own systems without polling.

### Context

The platform *receives* signed postbacks (`03-postback-integration.md`) but
never sends anything out. Brands currently have to poll.

This is the hardest reliability problem in the codebase, because the failure is
in someone else's system: their endpoint will be slow, will return 500, will
hang, will present a broken TLS certificate, and will occasionally accept a
request and then time out — meaning you cannot know whether it was delivered.
Every one of those needs a defined behaviour.

### The concepts

**Exponential backoff with jitter.** Retry at 1s, 2s, 4s, 8s… and if you do it
without jitter, every one of a thousand failed deliveries retries at the same
instant and you DDoS the endpoint the moment it recovers — the thundering herd.
Full jitter (`random(0, base * 2^n)`) is the standard fix.

**A circuit breaker.** After N consecutive failures for one endpoint, stop
trying for a cooldown. Without it, one dead subscriber burns your entire worker
capacity on deliveries that cannot succeed, and healthy subscribers starve.

```text
   CLOSED ──5 consecutive failures──► OPEN ──cooldown 60s──► HALF_OPEN
      ▲                                                          │
      └────────────── one probe succeeds ────────────────────────┘
                      probe fails ⇒ back to OPEN
```

**At-least-once, and say so.** You cannot achieve exactly-once across a network
boundary. Sign every delivery, give it a unique `X-Delivery-Id`, and document
that receivers must be idempotent — which is BE-02 seen from the other side.

### Acceptance criteria

1. `WebhookEndpoint` per brand: url, a generated signing secret (sealed with
   `secret-box.ts` — recoverable, because we must sign with it), subscribed
   event types, `status`.
2. Events emitted **through the existing outbox** (US-19), in the same
   transaction as the state change. Do not add a second, weaker delivery path
   next to a good one that already exists.
3. Delivery signs with the same HMAC scheme as inbound postbacks — reuse
   `postback-signature.ts`; do not invent a second scheme.
4. Headers: `X-Delivery-Id`, `X-Event-Type`, `X-Signature`, `X-Timestamp`.
5. Retries at 1s, 2s, 4s, 8s, 16s, 32s with full jitter — 6 attempts, then
   `FAILED`. Any 2xx is success; `410 Gone` disables the endpoint immediately
   and does not retry.
6. **A 5s request timeout.** An endpoint that accepts a connection and never
   responds must not hold a worker forever. This is the failure mode people
   forget.
7. Circuit breaker per endpoint: 5 consecutive failures → `OPEN` for 60s →
   `HALF_OPEN` lets exactly one probe through.
8. `WebhookDelivery` rows record attempt count, last status code, last error,
   and the next scheduled attempt. Brands can see their own delivery log and
   replay a failed one.
9. **SSRF protection**: reject urls resolving to private ranges
   (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`) at
   registration *and* at delivery time — DNS can change between the two, and
   checking only at registration is the classic hole.
10. Delivery is capped at 10 concurrent requests overall.

### Files to touch

- Schema: `WebhookEndpoint`, `WebhookDelivery`, plus a migration.
- `apps/api/src/services/webhook.service.ts` *(new)*.
- `apps/api/src/workers/webhook-delivery.worker.ts` *(new)*.
- `packages/analytics/src/backoff.ts` *(new)* — `nextDelay(attempt, seed)`,
  pure and unit tested with a seeded RNG.
- `packages/analytics/src/circuit-breaker.ts` *(new)* — a pure state machine
  over `(state, consecutiveFailures, openedAt, now)`. Unit test every edge.
- `apps/api/src/lib/ssrf.ts` *(new)*.
- `apps/api/src/routes/webhook.routes.ts` *(new)*.

### Tests

- Unit: backoff is monotonic in expectation, bounded, and jittered (two seeds
  differ); breaker transitions on every edge including the half-open probe.
- Unit: SSRF guard accepts a public IP and rejects each private range.
- Integration against a local stub server: 500 then success → 2 deliveries,
  1 row, status `DELIVERED`.
- Six failures → `FAILED`, exactly 6 attempts, no seventh.
- A hanging endpoint is abandoned at 5s.
- Breaker opens after 5 failures and the sixth delivery is *not* attempted.

---

# BE-06 — Query plans, indexes, and the N+1

**Size** L · **Depends on** BE-04 · **Priority** medium

**As an** engineer
**I want** to find slow queries with evidence rather than intuition
**so that** optimisation effort goes where the time actually is.

### Context

Nobody has looked at a query plan in this codebase. There is a seed script, but
it creates a handful of rows — so every query is fast, every plan is a
sequential scan over 12 rows, and nothing that will hurt in production is
visible yet.

There are concrete suspects:

- `flushBatch` (`click-event.worker.ts:87`) does `await tx.clickEvent.create()`
  **inside a `for` loop** — 100 round-trips per batch inside one transaction,
  where one `createMany` would do. A textbook N+1 in a write path.
- `analytics.service.ts` and `breakdown.service.ts` build raw SQL with
  `Prisma.sql`; the aggregates over `ClickEvent` and `Conversion` have no
  covering indexes for the filter+group combinations they use.
- `ClickEvent` has six single-column indexes (`schema.prisma:240-245`).
  Single-column indexes are frequently the *wrong* answer — Postgres can only
  combine them via a bitmap scan, and a composite index in the right column
  order usually beats all of them while costing less on write.

### Acceptance criteria

1. `npm run seed:bulk` generates a realistic volume — ≥ 500k `ClickEvent`,
   ≥ 50k `Conversion`, ≥ 200 links — using `createMany` batches, in under two
   minutes. Deterministic given a seed, so numbers are comparable run to run.
2. A short doc `fabledocs/05-query-performance.md` records, for each of the six
   slowest queries: the `EXPLAIN (ANALYZE, BUFFERS)` **before**, the change,
   and the plan **after**. Include the plans, not just the timings — the plan
   is the explanation.
3. `flushBatch` uses `createMany` for click events. Measure the batch flush
   before and after, and put the number in the PR.
4. Every index you add is justified by a plan that changes. Every index you
   *remove* is justified by showing nothing used it. Removing a useless index
   is as much a win as adding a good one, and it is the half people skip.
5. A slow-query log: any request whose total DB time exceeds 200ms logs at
   `warn` with route, duration, and correlation id (BE-08 gives you the id;
   land them in either order and say which).
6. No query in the admin dashboard path exceeds 100ms at seeded volume.
7. `ANALYZE` is run after bulk seeding — a plan taken against stale statistics
   is not evidence, and knowing that is half the skill.

### The technique, briefly

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT ...;
```

Read it inside-out. What you are looking for:

- `Seq Scan` on a large table with a selective filter → missing index.
- `Rows Removed by Filter: 400000` → the index you have is not selective.
- Estimated rows wildly different from actual → stale statistics; `ANALYZE`.
- `Nested Loop` with a big outer → often a missing index on the inner side.
- High `read` in BUFFERS vs `hit` → going to disk, not cache.

### Files to touch

- `apps/api/prisma/seed-bulk.ts` *(new)*.
- `apps/api/src/workers/click-event.worker.ts` — `createMany`.
- `apps/api/src/services/analytics.service.ts`, `breakdown.service.ts`.
- `apps/api/prisma/schema.prisma` — index changes + migration.
- `apps/api/src/config/prisma.ts` — query timing hook.
- `fabledocs/05-query-performance.md` *(new)*.

### Tests

- `createMany` still produces identical rows to the loop: same count, same
  fields, counters still correct. Refactors of write paths need equivalence
  tests, not just "it's faster".
- Bot-filtered events still excluded from counters after the rewrite.
- A regression test asserting the dashboard query stays under budget at seeded
  volume (skipped unless `BULK_SEED=1`, so CI stays fast).

---

# BE-07 — Distributed scheduling with leader election

**Size** M · **Depends on** — · **Priority** high

**As an** operator running more than one API instance
**I want** each scheduled job to run once per interval across the fleet
**so that** lock expiry, notification delivery and cleanup do not run N times
in parallel and corrupt each other.

### Context

**This is a live bug, not a hypothetical.** `server.ts:90` starts three workers
with `setInterval` in every process that boots:

```ts
if (!env.DISABLE_WORKERS) {
  startClickEventWorker();
  startLockExpiryWorker();
  startNotificationWorker();
}
```

Run two instances behind a load balancer — the normal way to get availability —
and every job runs twice per tick. Consequences differ per worker, and telling
them apart is the point of this story:

- **Click events**: safe. `RPOP` is atomic, so two consumers of the same Redis
  list just share the work. This one should stay as it is, and the PR should
  say why rather than "fixing" it.
- **Lock expiry**: unsafe. Two instances read the same expired commissions and
  both transition them; whether that double-counts depends on the query, which
  is exactly the kind of thing you should not have to reason about.
- **Notifications**: unsafe. Two instances claim the same pending rows and the
  user gets every notification twice.

`heartbeat.ts` already writes a Redis key per worker with a TTL — most of the
primitive you need is sitting there.

### The concept: a lease, not a lock

A distributed "lock" held by a process that has crashed must eventually be
released, or the job stops forever. So what you actually want is a **lease**: a
lock with a TTL, renewed by the holder while it works.

```text
SET scheduler:lock:notification <instance-id> NX PX 30000
  → OK     ⇒ I am the leader for 30s; renew every 10s while I work
  → nil    ⇒ someone else is; skip this tick, try again next tick
```

Two rules that are the entire difficulty:

1. **Release must be conditional.** `DEL` is wrong: if your lease expired and
   another instance took it, your `DEL` deletes *their* lease. Release with a
   Lua script that deletes only if the value still matches your instance id —
   compare-and-delete, atomically.
2. **A job must not outlive its lease.** If work takes longer than the TTL and
   you have not renewed, two instances are running and you have no lock at all.
   Either renew, or make the TTL comfortably exceed the worst case, and know
   which you chose.

### Acceptance criteria

1. `apps/api/src/lib/lease.ts` — `withLease(name, ttlMs, fn)`. Acquires via
   `SET NX PX`, runs `fn`, releases via compare-and-delete Lua. Returns
   `{ ran: false }` without calling `fn` if the lease was not acquired.
2. The lease auto-renews at TTL/3 while `fn` is running, and stops on
   settle — including when `fn` throws.
3. If renewal fails because the lease was lost, `fn` is signalled through an
   `AbortSignal` and the result is logged at `error`. Losing a lease silently
   is worse than crashing.
4. `lock-expiry` and `notification` workers run inside `withLease`.
5. `click-event` deliberately does **not**, with a comment saying why.
6. Every instance gets a stable `INSTANCE_ID` (env var, else a generated cuid
   at boot) and it appears in every log line.
7. `GET /api/admin/system/health` shows, per job, the current leaseholder and
   when it last ran — so an operator can see leadership move.
8. A test proves it: run `withLease` from **10 concurrent callers** with a
   counter inside; the counter increments **once**.
9. A crashed leader is recovered: acquire a lease, do not release it, wait past
   the TTL, and prove another caller can acquire.

### Files to touch

- `apps/api/src/lib/lease.ts` *(new)*, `lease.test.ts`.
- `apps/api/src/workers/lock-expiry.worker.ts`, `notification.worker.ts`.
- `apps/api/src/config/env.ts` — `INSTANCE_ID`.
- `apps/api/src/services/system.service.ts`, `admin.routes.ts`.

### Tests

- 10 concurrent `withLease` calls → body runs once, 9 report `ran: false`.
- Lease expiry after a simulated crash lets the next caller in.
- Compare-and-delete: instance A's stale release does **not** free instance B's
  lease. Write this one deliberately — it is the subtle failure and the reason
  `DEL` is wrong.
- A throwing `fn` still releases.
- Renewal keeps a long job's lease alive past the original TTL.

---

# BE-08 — Correlation IDs and RED metrics

**Size** M · **Depends on** — · **Priority** medium

**As an** on-call engineer
**I want** every log line for one request to share an id, and a metrics
endpoint that shows rate, errors and duration
**so that** "it was slow at 14:03" becomes a query rather than a guess.

### Context

`logger.ts` is a bare pino instance. Logs carry no request id, so a request
that touches four services produces four unrelated lines and there is no way to
reassemble them. There are no metrics at all: `/health` returns `{status:'ok'}`
and tells you nothing about whether the service is *working*, only that the
process is running — the distinction that matters at 3am.

### The concepts

**Correlation ids** propagate through the call stack without being threaded
through every function signature. Node's `AsyncLocalStorage` is the mechanism:
a store bound at the request boundary, readable anywhere downstream — including
inside the Prisma hook and the workers.

**RED** — Rate, Errors, Duration — is the standard service-level triad.
Duration must be a **histogram**, not an average: a mean of 50ms hides that 1%
of users wait 5 seconds, and it is always the tail that is the incident.

### Acceptance criteria

1. Every request gets an id: the inbound `X-Request-Id` if present and sane
   (≤ 128 chars, no control characters — do not trust it blindly), else a
   generated one. Echoed on the response.
2. `AsyncLocalStorage` carries `{ requestId, userId, route }`. The logger picks
   them up automatically — no call site passes a request id by hand.
3. Every log line inside a request carries `requestId`, including from services
   and repositories.
4. The id propagates to the redirect service and back through the click-event
   queue payload, so a click can be traced from redirect to Postgres row. This
   is the hard half and the one worth doing.
5. `GET /metrics` in Prometheus text format, on the internal (unprefixed) route
   group so it is not publicly exposed:
   - `http_requests_total{method,route,status}` — counter
   - `http_request_duration_seconds{method,route}` — histogram with explicit
     buckets, and say why you chose them
   - `queue_depth{queue}` — gauge for `click_events`, DLQ, parked
   - `worker_last_run_timestamp{worker}` — gauge, from the heartbeats
   - `db_query_duration_seconds` — histogram
6. Route labels use the **pattern** (`/api/brand/campaigns/:id`), never the
   resolved path. Per-id labels are unbounded cardinality and will take down
   your metrics backend before they help you.
7. Errors log the id at the point they are thrown, not only at the handler.
8. `/health` gains a real readiness check — Postgres `SELECT 1` and Redis
   `PING` with a 1s timeout — while `/health/live` stays trivially cheap.
   Liveness and readiness are different questions and should not share an
   endpoint.

### Files to touch

- `apps/api/src/lib/request-context.ts` *(new)* — `AsyncLocalStorage`.
- `apps/api/src/lib/logger.ts` — mixin pulling from the store.
- `apps/api/src/plugins/observability.ts` *(new)*.
- `apps/api/src/lib/metrics.ts` *(new)* — hand-rolled or `prom-client`; if you
  hand-roll it, say why in the PR.
- `apps/redirect/src/` — accept and forward the id.
- `apps/api/src/workers/click-event.worker.ts` — restore the id when handling.

### Tests

- A request with `X-Request-Id: abc` logs `abc` and echoes it back.
- Without the header, one is generated and is stable within the request.
- A hostile header (2KB, or containing `\n`) is rejected, not echoed. Log
  injection via an unvalidated echoed header is a real vulnerability.
- Two concurrent requests do not see each other's context — the test that
  actually exercises `AsyncLocalStorage`.
- `/metrics` parses as Prometheus text and counts increment.
- Route label is the pattern, not the resolved id.

---

# BE-09 — Per-key rate limiting with a token bucket

**Size** M · **Depends on** BE-07 (Redis Lua) · **Priority** medium

**As a** platform operator
**I want** limits applied per API key and per user, shared across instances
**so that** one noisy integration cannot consume the capacity of every other
tenant.

### Context

`server.ts:56` registers `@fastify/rate-limit` with `max: 200` per minute. Two
problems:

- **It is per-instance and in-memory.** Two instances means the effective limit
  is 400, and it resets whenever a process restarts. The limit you configured
  is not the limit you have.
- **It is global, not per-tenant.** One brand's misbehaving postback script can
  exhaust the budget for everybody. Limits are only meaningful when they are
  scoped to the thing you want to isolate.

A fixed window also permits a **boundary burst**: 200 requests at 11:59:59 and
200 more at 12:00:00 is 400 in one second, entirely within the limit as
configured.

### The concept: token bucket

A bucket of capacity `C` refilling at `R` tokens/second. A request takes one
token; none available means reject. It permits a legitimate burst up to `C`
while bounding the sustained rate to `R` — which is the behaviour you actually
want and which a fixed window cannot express.

The elegance is that you do not need a timer. Store `(tokens, lastRefillMs)`
and compute the refill lazily on read:

```lua
-- must be one Lua script: read-modify-write from the app is a race
local elapsed = now - last_refill
local tokens = math.min(capacity, tokens + elapsed * refill_rate / 1000)
if tokens < 1 then return {0, retry_after} end
return {1, 0}   -- and persist tokens - 1
```

Doing this in application code is a lost-update race under concurrency: two
requests read 1 token, both decrement, both proceed. Atomicity is the whole
point, and Redis executes a Lua script atomically.

### Acceptance criteria

1. `apps/api/src/lib/rate-limiter.ts` implements the bucket as a Lua script,
   `EVALSHA` with an `EVAL` fallback on `NOSCRIPT`.
2. Tiers, configurable per route:
   - postback endpoints: per **API key**, 100/min burst 200
   - authenticated API: per **user**, 300/min burst 500
   - auth endpoints: per **IP**, 10/min burst 15 (brute force)
   - public endpoints: per IP, 60/min burst 100
3. `429` responses carry `Retry-After` and `X-RateLimit-{Limit,Remaining,Reset}`.
   Rejecting without telling the client when to come back guarantees they hammer
   you.
4. Limits are shared across instances — prove it by pointing two limiter
   instances at one Redis and exhausting the budget through both.
5. **Redis being down must not take the API down.** Fail *open* for normal
   traffic and log at `error`. State the trade-off explicitly: an availability
   choice that weakens a security control. For auth endpoints, fail **closed** —
   the brute-force limit is the control itself, and losing it is worse than
   rejecting logins.
6. Admin role is exempt, and the exemption is logged.
7. The old global limiter is removed, and the `rateLimit: false` test option
   keeps working — a lot of tests depend on it.

### Files to touch

- `apps/api/src/lib/rate-limiter.ts` *(new)* + Lua.
- `apps/api/src/plugins/rate-limit.ts` *(new)*.
- `apps/api/src/server.ts` — remove `@fastify/rate-limit`.
- `packages/analytics/src/token-bucket.ts` *(new)* — the pure refill maths,
  unit tested at boundaries without Redis.

### Tests

- Unit: refill maths — empty bucket after `C` requests; exactly `R` more after
  one second; never exceeds `C` however long it idles.
- Burst of 200 succeeds, 201st is `429` with a sane `Retry-After`.
- Two keys have independent budgets.
- Concurrency: `Promise.all` of 250 → exactly 200 succeed. The lost-update race
  fails this and nothing else catches it.
- Redis down → normal routes serve, auth routes reject.
- Headers present and arithmetically correct on both 200 and 429.

---

# BE-10 — Bulk conversion import, streamed

**Size** L · **Depends on** BE-02, BE-03 · **Priority** low

**As a** brand migrating from another platform
**I want** to upload a CSV of historical conversions and get a per-row report
**so that** I can move without hand-writing a script against the postback API.

### Context

Conversions arrive one at a time. A brand with 50,000 historical rows has no
path in and will write a loop that hammers the postback endpoint for an hour.

The naive implementation — read the file into memory, `JSON.parse`, loop — dies
on a 200MB upload, and dies in the worst way: the process runs out of memory and
takes every in-flight request with it. This story is about **bounded memory**
and **partial failure**, which are the two things bulk endpoints are actually
about.

### The concepts

**Streaming and backpressure.** Parse the upload as it arrives, in chunks, and
never hold more than one batch in memory. If the database is slower than the
network, the parser must *pause* — that is backpressure, and getting it wrong
is how you turn a slow database into an OOM.

**Partial failure.** With 50,000 rows and 12 bad ones, all-or-nothing is
useless: the brand fixes 12 rows and re-uploads 50,000. Per-row outcomes, and
re-running the same file must not double-import — which is BE-02's idempotency
at row granularity, keyed on `(campaignId, externalOrderId)`, a constraint that
already exists (`schema.prisma:289`).

**Long-running work does not belong in a request.** The upload returns a job id
immediately; a worker processes it; the client polls. An HTTP request that takes
four minutes will be killed by something between you and the client, and you
will not be told.

### Acceptance criteria

1. `POST /api/brand/campaigns/:id/conversions/import` accepts `multipart/form-data`
   (`@fastify/multipart`), streams to a temp file, returns `202` with a job id.
   Reject > 100MB and > 100k rows **while streaming**, not after.
2. Parsed with a streaming CSV parser. Peak RSS stays flat regardless of file
   size — prove it in the PR with a measurement over a 50k-row file.
3. Required columns `externalOrderId,conversionValue,occurredAt`; optional
   `subId1..5,customerEmail`. A missing required *column* fails the whole job
   immediately with a clear message — that is a malformed file, not a bad row.
4. Rows are validated with the same Zod schema as the postback endpoint. One
   schema, two entry points; a second copy will drift.
5. Rows insert in batches of 500 via `createMany` with `skipDuplicates`.
   Batch-level failure bisects (reuse BE-03's helper) so one bad row costs one
   row.
6. `ImportJob` tracks `status`, `totalRows`, `importedRows`, `skippedRows`,
   `failedRows`, and up to 1,000 per-row errors as
   `{ line, column, message }`. Cap it — a fully invalid 50k file must not
   write 50k error rows.
7. `GET /api/brand/import-jobs/:id` returns progress; a completed job offers an
   error CSV of only the failed rows, with the original line numbers, so the
   brand can fix and re-upload just those.
8. Re-uploading the same file imports **nothing new** and reports every row as
   skipped.
9. Imported conversions are marked `source: 'IMPORT'` and **skip fraud
   scoring** — historical data has no click events, and scoring it would flag
   everything. Say this in the PR; it is the domain judgement the story is
   really testing.
10. The temp file is deleted on success *and* on failure. Use `try/finally`.

### Files to touch

- `apps/api/src/routes/import.routes.ts` *(new)*.
- `apps/api/src/services/import.service.ts` *(new)*.
- `apps/api/src/workers/import.worker.ts` *(new)*.
- `packages/shared/src/schemas/import.schemas.ts` *(new)*.
- Schema: `ImportJob`, `ImportJobError`, `Conversion.source`.

### Tests

- 1,000 valid rows → 1,000 conversions, status `COMPLETED`.
- 100 rows with 3 invalid → 97 imported, 3 errors with correct line numbers.
  Line numbers are what make the report usable; assert them exactly.
- Re-import → 0 imported, all skipped.
- Missing a required column → job fails immediately, nothing imported.
- A file exceeding the row cap is rejected mid-stream, not after buffering.
- Memory: a 50k-row import stays under a fixed RSS ceiling.
- The temp file is gone after both a successful and a failed run.

---

## A note on how to work through these

Do them one per pull request, smallest coherent change each time, and write the
PR description **for the person who has to change this in a year**. The commit
that says *what* changed is nearly worthless — `git diff` says that better than
prose. The commit that says *why* is the one that stops someone reverting your
fix because they could not see the bug it prevented.

Four of these stories (BE-01, BE-02, BE-03, BE-07) are all the same lesson from
different angles: **a check and the action it authorises must be atomic, or they
are not a check.** Once you have seen it as a lost update, a double delivery, a
poisoned batch and a split brain, you will start seeing it in code review before
it ships. That is the actual goal.
