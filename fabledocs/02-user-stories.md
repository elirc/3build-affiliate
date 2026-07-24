# User stories — next phase

20 stories, ordered so that earlier ones unblock later ones. Each is written to
be picked up cold: it says what to build, how you'll know it's done, which
files to open, and what to test.

**Read [01-app-overview.md](./01-app-overview.md) first.** These stories assume
you know the commission state machine and the click/conversion flows.

## How to read a story

- **Size** — S (≤ half a day), M (1–2 days), L (3–5 days). Rough, not a promise.
- **Acceptance criteria** — numbered and testable. If you can't write a test
  for one, it's badly written; push back.
- **Files to touch** — a starting map, not an exhaustive list.
- Every story is done when: criteria pass, tests are written, `npm run test`
  and `npm run typecheck` are green, and no `any` was added to get there.

## Definition of done (applies to all)

1. Input validated by a Zod schema in `packages/shared/src/schemas/`.
2. Route is thin; workflow lives in a service; Prisma lives in a repository.
3. Ownership/authorization is enforced **in the service**, not the route.
4. Errors thrown via `Errors.*` from `apps/api/src/lib/errors.ts`.
5. Money handled as `Decimal` in the DB and strings over the wire.
6. New pure logic goes in `packages/analytics` with a unit test.
7. UI mutations invalidate the relevant TanStack Query keys.

## Board

| # | Story | Size | Depends on |
| --- | --- | --- | --- |
| US-01 | Campaign lifecycle controls | M | — |
| US-02 | Affiliate creates and manages tracking links in the UI | M | US-01 |
| US-03 | Redirect survives a cache miss | M | — |
| US-04 | Session hardening: route guards + silent token refresh | M | — |
| US-05 | Authenticated conversion postbacks | L | — |
| US-06 | Payout processing lifecycle | L | — |
| US-07 | Payout request safety: idempotency + concurrency | M | US-06 |
| US-08 | Refunds and clawbacks | M | US-06 |
| US-09 | Per-affiliate custom commission rates | M | US-01 |
| US-10 | Creative asset library | L | US-01 |
| US-11 | Recurring commissions that actually recur | L | US-05 |
| US-12 | Profile and payment settings | M | US-04 |
| US-13 | Per-campaign and per-affiliate performance tables | M | — |
| US-14 | Sub-ID reporting | M | US-02 |
| US-15 | CSV export | S | US-13 |
| US-16 | Date-range picker with period comparison | M | US-13 |
| US-17 | Admin system health page | M | — |
| US-18 | Bot and duplicate click filtering | M | US-03 |
| US-19 | Notifications via a transactional outbox | L | US-06 |
| US-20 | Integration test harness | L | — |

---

# Epic A — Make the happy path work end to end

## US-01 — Campaign lifecycle controls

**Size** M · **Depends on** — · **Priority** highest

**As a** brand owner
**I want** to move a campaign between draft, active, paused and ended
**so that** affiliates can actually find and join my program, and so I can stop
it without deleting it.

### Context

`campaignService.create` never sets `status`, so Prisma applies the schema
default of `DRAFT` (`schema.prisma:97`). A `DRAFT` campaign is invisible to
`listOpenForAffiliates` (which filters `status: 'ACTIVE'`), and both
`relationshipService.apply` and `trackingService.create` reject non-`ACTIVE`
campaigns. `PATCH /api/brand/campaigns/:id` already accepts a `status` field —
there is simply no UI for it, and no rules about which transitions are legal.

Today the seeded campaign is the only working one because the seed hardcodes
`status: 'ACTIVE'`.

### Acceptance criteria

1. The campaign detail page shows the current status and offers only the
   **legal** next transitions as buttons.
2. Legal transitions are exactly:
   `DRAFT → ACTIVE`, `ACTIVE → PAUSED`, `ACTIVE → ENDED`,
   `PAUSED → ACTIVE`, `PAUSED → ENDED`. Everything else is a `400` with code
   `INVALID_TRANSITION`. `ENDED` is terminal.
3. Activating a campaign requires `endDate` to be null or in the future;
   otherwise `400`.
4. A `PAUSED` campaign: existing tracking links keep redirecting and existing
   conversions can still be reported, but **new** link creation and **new**
   applications are rejected with a message naming the status.
5. An `ENDED` campaign: new conversions are rejected with `422`; the redirect
   service serves the campaign's `landingPageUrl` rather than the global
   fallback (so traffic isn't wasted).
6. The campaigns list shows a status badge and can be filtered by status
   (`GET /api/brand/campaigns?status=` already supports it).
7. The detail page also allows editing name, description, landing page URL, and
   allowed domains while the campaign is `DRAFT`. After activation, commission
   structure and attribution settings become **read-only** — changing the deal
   under affiliates who already joined is not allowed.

### API contract

```http
POST /api/brand/campaigns/:id/transition
Authorization: Bearer <brand token>
{ "to": "ACTIVE" }            →  200 { ...campaign }
                              →  400 { error: { code: "INVALID_TRANSITION", ... } }
```

Keep `PATCH /api/brand/campaigns/:id` for field edits; make it **reject** a
`status` key so there's exactly one way to change state.

### Files to touch

- `packages/shared/src/schemas/campaign.schemas.ts` — add
  `transitionCampaignSchema`; remove `status` from `updateCampaignSchema`.
- `packages/analytics/src/campaign-lifecycle.ts` *(new)* — a pure
  `canTransition(from, to): boolean` + the transition map. Unit test it.
- `apps/api/src/services/campaign.service.ts` — `transition()`, plus the
  read-only-after-activation rule in `update()`.
- `apps/api/src/routes/campaign.routes.ts`
- `apps/api/src/services/tracking.service.ts:25` and
  `relationship.service.ts:21` — error messages should name the actual status.
- `apps/web/src/app/(brand)/brand/campaigns/[id]/page.tsx` — status badge,
  transition buttons with a confirm on `ENDED`, edit form.
- `apps/web/src/app/(brand)/brand/campaigns/page.tsx` — badge + filter.

### Tests

- Unit: every legal and illegal transition in `campaign-lifecycle.test.ts`.
- Service: activating with a past `endDate` throws; editing
  `commissionStructure` on an `ACTIVE` campaign throws `FORBIDDEN`.

### Out of scope

Scheduled/automatic activation on `startDate`. Deleting campaigns.

---

## US-02 — Affiliate creates and manages tracking links in the UI

**Size** M · **Depends on** US-01

**As an** affiliate
**I want** to generate a tracking link for a campaign I've been approved for,
copy it, and pause it later
**so that** I can start promoting without anyone hand-rolling an API call.

### Context

`POST /api/affiliate/links` and `PATCH /api/affiliate/links/:id` both exist and
work (`tracking.routes.ts`). `apps/web/.../affiliate/links/page.tsx` is a
read-only table. There is also no way for an affiliate to see *which* campaigns
they're eligible for — `/api/affiliate/applications` returns brands, not
campaigns.

### Acceptance criteria

1. A "New link" button opens a form with: campaign (dropdown of eligible
   campaigns only), destination URL, optional custom alias.
2. The campaign dropdown lists only `ACTIVE` campaigns belonging to brands where
   the affiliate's `BrandAffiliate.status === 'APPROVED'`. Empty state links to
   `/programs`.
3. The destination URL field shows the campaign's `allowedDomains` as helper
   text, and a client-side check warns before submitting if the hostname won't
   pass. The server remains the authority.
4. Server errors surface inline and readably — specifically the domain
   rejection and the "Tracking link limit reached" case
   (`MAX_TRACKING_LINKS_PER_AFFILIATE_PER_CAMPAIGN = 25`).
5. Each row has a **Copy** button that copies the full short URL
   (`NEXT_PUBLIC_REDIRECT_URL` + `/r/` + `shortCode`) and shows a "Copied"
   confirmation.
6. Each row has an active/paused toggle wired to `PATCH`. Optimistic update,
   rolled back on error.
7. Rows show EPC (`revenue / clickCount`, `—` when clicks are 0) alongside the
   existing counters.
8. The `NAV` array on this page matches the other affiliate pages (it's
   currently missing "My Applications").

### API contract

```http
GET /api/affiliate/eligible-campaigns   → 200 [{ id, name, brandName, allowedDomains, commissionSummary }]
```

`commissionSummary` is a display string built from `commissionStructure`
("20%", "$25 flat", "Tiered, 15–25%"). Build it as a pure function in
`packages/analytics` so the brand campaign detail page can reuse it — that page
currently has the same formatting logic inline
(`(brand)/brand/campaigns/[id]/page.tsx:42`).

### Files to touch

- `packages/analytics/src/commission-format.ts` *(new)* + test.
- `apps/api/src/repositories/campaign.repository.ts` — `listEligibleForAffiliate`.
- `apps/api/src/services/tracking.service.ts`, `routes/tracking.routes.ts`.
- `apps/web/src/app/(affiliate)/affiliate/links/page.tsx`.
- Extract the duplicated `NAV` arrays into
  `apps/web/src/components/nav.ts` while you're here.

### Tests

- Service: eligible-campaigns excludes brands whose relationship is `PENDING`,
  `REJECTED` or `DEACTIVATED`, and excludes non-`ACTIVE` campaigns.
- Unit: `commissionSummary` for all four structure types.

---

## US-03 — Redirect survives a cache miss

**Size** M · **Depends on** — · **Priority** highest

**As an** affiliate
**I want** my tracking links to keep working forever
**so that** clicks I earned aren't silently thrown away.

### Context

**This is the most damaging bug in the app.** `tracking.service.ts:18` caches a
link in Redis with `EX 3600`. `apps/redirect/src/server.ts:30` reads Redis and
*only* Redis:

```ts
const cached = await redis.get(`link:${shortCode}`);
if (!cached) return reply.redirect(FALLBACK_URL, 302);
```

So **one hour after a link is created**, or immediately after any Redis restart
or eviction (the container runs `--maxmemory 512mb --maxmemory-policy
allkeys-lru`), every click on every link redirects to `example.com` and is
never recorded. The affiliate earns nothing and nobody gets an error.

### Acceptance criteria

1. On a cache miss the redirect service resolves the short code from an
   authoritative source and serves the correct destination.
2. After a miss, the entry is repopulated in Redis so the next click is a hit.
3. Resolution has a **hard timeout of 150 ms**. On timeout or error, fall back
   to `DEFAULT_FALLBACK_URL` and log a warning — a slow lookup must never hang
   a shopper.
4. Unknown short codes are negatively cached for 60 seconds so a scanner can't
   generate unbounded lookups.
5. The cache entry no longer expires on a fixed 1-hour TTL. Either drop the TTL
   and invalidate explicitly on write, or keep a long TTL (24h) *plus* the
   miss-path rehydration. State which you chose in a comment and why.
6. Deactivating a link takes effect within 5 seconds (invalidate on write,
   don't wait for TTL).
7. A load-shedding note in the README: what happens if Redis is down entirely.

### Design decision required

Two viable approaches — pick one, write down the trade-off in the PR:

- **(a) Internal API endpoint.** `GET /internal/links/:shortCode` on the API,
  protected by a shared secret header (`INTERNAL_API_TOKEN`), returning the
  `CachedTrackingLink` shape. Keeps the redirect service database-free.
- **(b) Read-only Prisma client in the redirect service.** Simpler, one less
  hop, but couples the hot path to the database and to Prisma's cold start.

(a) is recommended: it preserves the reason this service exists.

### Files to touch

- `apps/redirect/src/server.ts` — miss path, timeout, negative cache.
- `apps/redirect/src/link-resolver.ts` *(new)* — resolution + caching, so it
  can be tested without a live Fastify server.
- `apps/api/src/routes/internal.routes.ts` *(new)* if you pick (a).
- `apps/api/src/services/tracking.service.ts` — invalidation on toggle.
- `.env.example`, `apps/redirect/package.json`.

### Tests

- Resolver returns the cached value without calling the API when Redis hits.
- Resolver calls the API, returns the link, and writes it back on a miss.
- Resolver returns `null` (→ fallback) when the API exceeds the timeout;
  assert with a fake timer, not a real sleep.
- Second lookup of an unknown code within 60s makes no API call.

---

## US-04 — Session hardening: route guards and silent token refresh

**Size** M · **Depends on** —

**As a** logged-in user
**I want** my session to keep working for as long as I'm active, and to be sent
to the login page when it doesn't
**so that** I don't stare at a dashboard full of silently failed requests.

### Context

Access tokens live 15 minutes. `apps/web/src/lib/api.ts` never refreshes them
and never reacts to a `401`. `POST /api/auth/refresh` exists and is unused.
There is no `middleware.ts`, so `/brand/dashboard` renders its whole shell for a
logged-out visitor; only the API calls fail. The `useAuth` zustand store
(`lib/store.ts`) is written once at login and read nowhere.

### Acceptance criteria

1. A `401` from any API call triggers **one** refresh attempt using the stored
   refresh token, then replays the original request transparently.
2. Concurrent `401`s share a single in-flight refresh — five parallel queries
   must not fire five refreshes.
3. If refresh fails, tokens are cleared and the user is redirected to
   `/login?next=<current path>`; login honours `next`.
4. Visiting a role-protected route without a token redirects to `/login`
   before any dashboard chrome renders.
5. Visiting a route for the wrong role (an affiliate opening `/brand/...`)
   redirects to that user's own dashboard, not to login.
6. The refresh token is stored somewhere the access token is not — document the
   choice. (Recommended: refresh token in an httpOnly cookie set by the API,
   which requires adding cookie-setting to the auth routes. If you keep it in
   `localStorage`, say so explicitly and note the XSS exposure.)
7. `logout` calls `POST /api/auth/logout` (bumping `tokenVersion`) *before*
   clearing local state — today `DashboardShell.logout` only clears
   `localStorage`, so the token stays valid server-side until it expires.
8. The `useAuth` store is the single source of truth for the current user, and
   is rehydrated on load from `GET /api/auth/me`.

### Files to touch

- `apps/web/src/lib/api.ts` — refresh interceptor with a shared promise.
- `apps/web/src/lib/auth-guard.tsx` *(new)* or `apps/web/src/middleware.ts`.
- `apps/web/src/lib/store.ts`, `components/DashboardShell.tsx`.
- `apps/web/src/app/(public)/login/page.tsx` — `next` param.
- `apps/api/src/routes/auth.routes.ts` if you move to cookies.

### Tests

- Unit the refresh queue with a mocked `fetch`: two simultaneous 401s produce
  exactly one refresh call and two successful retries.
- A failing refresh clears the token store.

### Out of scope

Remember-me durations, device/session management UI.

---

# Epic B — Trust and money

## US-05 — Authenticated conversion postbacks

**Size** L · **Depends on** — · **Priority** highest

**As a** brand
**I want** only my own storefront to be able to report sales on my campaigns
**so that** nobody can invent conversions and drain my budget.

### Context

`POST /api/conversions/:campaignId` (`conversion.routes.ts:10`) has **no
authentication whatsoever**. Anyone who knows or guesses a campaign id can post
arbitrary `conversionValue`s. The only rate limiting is the global
200-requests-per-minute in `server.ts:31`, shared with every other route.

### Acceptance criteria

1. Each campaign can have one or more **API credentials**: a public key id and
   a secret shown **exactly once** at creation. Store only a hash of the secret.
2. Postbacks authenticate with an HMAC-SHA256 signature over the raw request
   body plus a timestamp:
   `X-Affiliate-Key`, `X-Affiliate-Timestamp`, `X-Affiliate-Signature`.
3. Requests with a timestamp more than **5 minutes** from server time are
   rejected `401` (replay protection).
4. Signature comparison uses `crypto.timingSafeEqual`.
5. Unauthenticated or badly signed requests get `401` with code
   `INVALID_SIGNATURE` and **no** hint about whether the campaign exists.
6. The conversion endpoint gets its own rate limit, keyed by key id, that is
   more generous than the global one (a Black Friday spike is legitimate).
7. The brand UI has a "Developers" tab per campaign: create a key, revoke a
   key, see last-used timestamp, and a copy-pasteable `curl` example with the
   signing code.
8. Revoked keys stop working immediately.
9. Fastify's raw body is available to the verifier — you'll need
   `addContentTypeParser` or the `rawBody` option; signing a re-serialised body
   will not match.

### Data model

```prisma
model CampaignApiKey {
  id          String    @id @default(cuid())
  campaignId  String
  campaign    Campaign  @relation(fields: [campaignId], references: [id])
  keyId       String    @unique          // public, e.g. "ak_live_9f3..."
  secretHash  String                     // argon2id of the secret
  label       String
  lastUsedAt  DateTime?
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())

  @@index([campaignId])
}
```

### Files to touch

- `apps/api/prisma/schema.prisma` + a migration.
- `apps/api/src/lib/postback-auth.ts` *(new)* — the `preHandler`.
- `apps/api/src/services/api-key.service.ts` *(new)*,
  `repositories/api-key.repository.ts` *(new)*.
- `apps/api/src/routes/conversion.routes.ts`, `campaign.routes.ts`.
- `apps/web/src/app/(brand)/brand/campaigns/[id]/page.tsx` — Developers tab.
- `fabledocs/` — add a short "Postback integration guide" page for brands.

### Tests

- Valid signature passes; tampered body fails; stale timestamp fails; revoked
  key fails; unknown key id fails — all with the same `401` shape.
- Key secret is never returned by any read endpoint.

### Out of scope

OAuth, per-affiliate postbacks, IP allowlisting.

---

## US-06 — Payout processing lifecycle

**Size** L · **Depends on** —

**As an** affiliate
**I want** to see my payout requests progress to "paid" and view my history
**so that** I know when I'm actually getting money.

**As an** admin
**I want** to process the payout queue
**so that** money leaves the platform deliberately, not automatically.

### Context

`payoutService.requestPayout` creates a `Payout(PENDING)` and flips commissions
to `INCLUDED_IN_PAYOUT`. **Nothing else ever happens.** No route transitions a
payout, so no commission ever reaches `PAID`, and the affiliate's "Paid
lifetime" tile is structurally always `$0.00`. There is also no endpoint to
list an affiliate's past payouts. `reviewPayoutSchema` already exists, unused,
in `packages/shared/src/schemas/payout.schemas.ts:7` — it was clearly planned.

### Acceptance criteria

1. `GET /api/affiliate/payouts` returns the affiliate's payouts, newest first,
   paginated, each with its commission count and the campaigns involved.
2. The affiliate payouts page shows this history alongside the request form,
   with status badges and the fee breakdown (gross / fee / net).
3. `GET /api/admin/payouts?status=` lists the queue for admins.
4. `POST /api/admin/payouts/:id/process` moves `PENDING → PROCESSING`.
5. `POST /api/admin/payouts/:id/complete` moves `PROCESSING → PAID`, stamps
   `paidAt`, and in the **same transaction** sets every attached commission to
   `PAID` with `paidAt`. Accepts an optional external reference
   (`stripeTransferId` or a bank reference) — reuse the column.
6. `POST /api/admin/payouts/:id/fail` moves `PENDING|PROCESSING → FAILED` with
   a required `failureReason`, and returns the attached commissions to
   `APPROVED` with `payoutId = null` so they can be re-requested.
7. `POST /api/admin/payouts/:id/cancel` (affiliate-requested cancellation)
   behaves like `fail` but sets `CANCELLED` and takes no reason.
8. Illegal transitions return `400 INVALID_TRANSITION`. `PAID` and `CANCELLED`
   are terminal.
9. Every transition is written to an audit trail (see data model) with the
   acting admin's id — this is money, we need to know who clicked what.
10. The affiliate earnings summary reflects reality: `paid` is non-zero once a
    payout completes.

### Data model

```prisma
model PayoutEvent {
  id        String   @id @default(cuid())
  payoutId  String
  payout    Payout   @relation(fields: [payoutId], references: [id])
  fromStatus PayoutStatus
  toStatus   PayoutStatus
  actorId    String?
  actor      User?    @relation(fields: [actorId], references: [id])
  reason     String?
  createdAt  DateTime @default(now())

  @@index([payoutId])
}
```

### Files to touch

- `apps/api/src/services/payout.service.ts`, `routes/payout.routes.ts`,
  `routes/admin.routes.ts`, `repositories/payout.repository.ts` *(new)*.
- `packages/analytics/src/payout-lifecycle.ts` *(new)* — pure transition map,
  same pattern as US-01.
- `apps/web/src/app/(affiliate)/affiliate/payouts/page.tsx`.
- `apps/web/src/app/(admin)/admin/payouts/page.tsx` *(new)*.

### Tests

- Completing a payout sets every attached commission to `PAID` — assert on the
  commission rows, not just the payout.
- Failing a payout returns commissions to `APPROVED` with a null `payoutId`,
  and they are then eligible for a fresh payout request.
- Transition table: every legal and illegal pair.

### Out of scope

Real Stripe Connect transfers (the columns exist; wiring the SDK is a separate
story). Tax forms. Multi-currency.

---

## US-07 — Payout request safety: idempotency and concurrency

**Size** M · **Depends on** US-06

**As a** platform operator
**I want** a double-clicked payout button to be impossible to over-pay
**so that** we don't send the same commission twice.

### Context

`payoutService.requestPayout` reads approved commissions **outside** the
transaction, sums them into `gross`, then inside the transaction does an
`updateMany` filtered on `status: 'APPROVED'`. If two requests race, the second
`updateMany` matches **zero rows** but the `Payout` row is still created with
the full `gross` amount — a payout for money that is already in another payout.

There is also no minimum-interval or in-flight check: an affiliate can create
unlimited `PENDING` payouts.

### Acceptance criteria

1. The commission selection and the payout creation happen in **one**
   transaction, and the payout `amount` is derived from the rows actually
   claimed (`updateMany`'s `count` and a re-aggregation inside the transaction),
   never from the pre-read.
2. If zero commissions are claimed, the transaction rolls back and the caller
   gets `409 NOTHING_TO_PAY`.
3. An affiliate with an existing `PENDING` or `PROCESSING` payout gets
   `409 PAYOUT_IN_FLIGHT`.
4. The endpoint accepts an optional `Idempotency-Key` header; replaying the same
   key within 24 hours returns the original payout instead of creating a new one.
5. A concurrency test proves it: fire N simultaneous requests for the same
   affiliate, assert exactly one payout exists and the sum of its commissions
   equals its `amount`.
6. Fee arithmetic keeps its current behaviour but gains a unit test:
   `fee = round(gross × PLATFORM_FEE_PERCENT) / 100`, `net = gross − fee`, both
   to 2 decimals. Add cases for `.005` rounding boundaries.

### Files to touch

- `apps/api/src/services/payout.service.ts`.
- `packages/analytics/src/payout-math.ts` *(new)* — extract fee/net so it's
  testable without a database.
- Consider `SELECT ... FOR UPDATE` via `$queryRaw` or a Postgres advisory lock
  keyed on `affiliateId`; document which and why.

### Tests

- The concurrency test above (needs US-20's harness, or a temporary
  `Promise.all` against a local DB).
- Idempotency key replay returns the same payout id.

---

## US-08 — Refunds and clawbacks

**Size** M · **Depends on** US-06

**As a** brand
**I want** to reverse a conversion after I've approved it, when the customer
refunds
**so that** I'm not paying commission on revenue I gave back.

### Context

`conversionService.review` refuses to touch a conversion that isn't `PENDING`
(`conversion.service.ts:169`). The only route to `CLAWED_BACK` today is an
admin fraud `BLOCKED` decision (`admin.routes.ts:59`). Real affiliate programs
reverse sales constantly; the `lockPeriodDays` hold exists precisely for this.

### Acceptance criteria

1. `POST /api/brand/conversions/:id/reverse` with a required reason works on an
   `APPROVED` conversion.
2. Behaviour depends on where the commission is in its lifecycle:
   - `LOCKED` or `APPROVED` → set `CLAWED_BACK`; nothing else to do.
   - `INCLUDED_IN_PAYOUT` → `400 COMMISSION_IN_PAYOUT`, telling the brand to
     wait for the payout to settle or fail.
   - `PAID` → set `CLAWED_BACK` and create a **negative balance adjustment**
     against the affiliate, which is netted off their next payout.
3. Reversal is idempotent: a second call returns `409` and changes nothing.
4. The `TrackingLink` denormalised counters are decremented to match.
5. Partial refunds are supported: an optional `refundAmount` less than
   `conversionValue` recomputes the commission pro rata rather than zeroing it,
   and the conversion keeps status `APPROVED` with an adjusted value.
6. The affiliate can see reversed conversions and the reason, in their earnings
   view — silent deductions destroy trust.
7. Brand conversions page gets a "Reverse" action on approved rows, with a
   confirm dialog and a required reason (replace the `prompt()` currently used
   for rejections at `(brand)/brand/conversions/page.tsx:111` while you're
   there — `prompt()` is blocked in some browsers).

### Data model

```prisma
model BalanceAdjustment {
  id           String   @id @default(cuid())
  affiliateId  String
  affiliate    User     @relation(fields: [affiliateId], references: [id])
  amount       Decimal  @db.Decimal(10, 2)   // negative for a clawback
  reason       String
  conversionId String?
  settledPayoutId String?
  createdAt    DateTime @default(now())

  @@index([affiliateId, settledPayoutId])
}
```

Wire unsettled adjustments into `payoutService.requestPayout` and into
`payoutService.summary`.

### Tests

- Each commission state produces the documented outcome.
- Pro-rata partial refund math (pure function, in `packages/analytics`).
- A clawback on a `PAID` commission reduces the next payout's net by exactly
  the clawed-back amount.

---

# Epic C — Program management depth

## US-09 — Per-affiliate custom commission rates

**Size** M · **Depends on** US-01

**As a** brand
**I want** to give my best affiliates a better rate than the public one
**so that** I can negotiate with high performers without creating a whole
separate campaign.

### Context

`BrandAffiliate.customCommission` is a `Json?` column that **nothing reads or
writes**. `conversion.service.ts:85` always uses
`campaign.commissionStructure`.

### Acceptance criteria

1. On the brand's Affiliates page, an approved partner can be given a custom
   commission structure, validated by the existing
   `commissionStructureSchema`.
2. The override applies to **all** of that brand's campaigns for that affiliate,
   because `BrandAffiliate` is brand-scoped — state this in the UI copy so
   nobody is surprised.
3. Commission resolution order at conversion time:
   `BrandAffiliate.customCommission` → `Campaign.commissionStructure`.
   Extract this into a pure `resolveCommissionStructure(campaign, relationship)`
   in `packages/analytics`.
4. Overrides only affect conversions **created after** the override is set.
   Existing commissions are never recalculated.
5. The override is visible to the affiliate on their applications page ("Custom
   rate: 30%") — hidden rates are a support burden.
6. An override can be removed, restoring the campaign default.
7. Every override change is recorded with who changed it, when, and the old
   value.

### Files to touch

- `packages/analytics/src/resolve-commission.ts` *(new)* + test.
- `apps/api/src/services/relationship.service.ts`,
  `routes/relationship.routes.ts`.
- `apps/api/src/services/conversion.service.ts:85` — load the relationship
  inside the transaction and pass it to the resolver.
- `apps/web/src/app/(brand)/brand/affiliates/page.tsx`,
  `(affiliate)/affiliate/applications/page.tsx`.

### Tests

- Resolver prefers the override; falls back when it's null; falls back when the
  relationship isn't `APPROVED`.
- A conversion reported after an override uses the new rate; one reported
  before keeps the old amount.

### Out of scope

Per-campaign-per-affiliate overrides (would need a new join table). Time-boxed
promotional rates.

---

## US-10 — Creative asset library

**Size** L · **Depends on** US-01

**As a** brand
**I want** to upload banners, logos and copy blocks for my campaign
**so that** affiliates promote me with on-brand material.

**As an** affiliate
**I want** to browse and grab those assets with my tracking link already
embedded
**so that** I can publish in a minute.

### Context

The `CreativeAsset` model exists (`schema.prisma:322`) with `type` values
`BANNER | LOGO | VIDEO | TEXT_SWIPE | OTHER` and dimension columns. There is no
route, no service, no UI, and no file storage configured anywhere in the repo.

### Acceptance criteria

1. Brands can upload an asset to a campaign: file (image) or text body for
   `TEXT_SWIPE`, plus a name and type.
2. Accepted image types: PNG, JPEG, GIF, WebP, SVG **rejected** (SVG is a
   script-execution vector). Max 5 MB. Validate by sniffing magic bytes, not by
   trusting `Content-Type` or the file extension.
3. Image width/height/`sizeBytes` are extracted server-side and stored.
4. Storage is behind a small interface with a local-disk implementation for
   dev (`apps/api/storage/`, gitignored) and a documented seam for S3 later.
   Do not commit an AWS dependency for this story.
5. Assets are served through the API, not from a public directory, so access
   can be checked.
6. Approved affiliates see a campaign's assets in a gallery. Non-approved
   affiliates get `403`.
7. For `BANNER` assets the gallery offers a one-click **embed snippet** with
   the affiliate's own tracking link already substituted:
   ```html
   <a href="https://links.example.com/r/k7m2xq9"><img src="..." width="728" height="90" alt="..."></a>
   ```
   If the affiliate has no link for that campaign yet, offer to create one
   (reuses US-02).
8. Brands can delete an asset; the file is removed and the row is soft-deleted
   so existing embeds fail loudly rather than 500.
9. Upload endpoint is rate-limited more tightly than the global default.

### Files to touch

- `apps/api/src/lib/storage.ts` *(new)* — the interface + local driver.
- `apps/api/src/services/creative.service.ts` *(new)*,
  `repositories/creative.repository.ts` *(new)*,
  `routes/creative.routes.ts` *(new)*.
- `@fastify/multipart` — new dependency.
- `apps/web/src/app/(brand)/brand/campaigns/[id]/page.tsx` — Creatives tab.
- `apps/web/src/app/(affiliate)/affiliate/creatives/page.tsx` *(new)*.

### Tests

- A `.png` renamed to `.jpg` is accepted by content, not extension; a `.svg` is
  rejected; a 6 MB file is rejected.
- A non-approved affiliate gets `403` on both list and download.

### Out of scope

Image resizing/CDN, versioning, per-asset performance stats.

---

## US-11 — Recurring commissions that actually recur

**Size** L · **Depends on** US-05

**As a** SaaS brand
**I want** to pay my affiliates on every month a referred customer stays
subscribed
**so that** the recurring commission option means what it says.

### Context

`calculateCommission` handles `recurring` identically to `percentage` and
ignores `recurringMonths` entirely (`commission-calc.ts:42`). A campaign
promising "30% for 12 months" pays 30% once. This is a correctness problem with
a commercial promise attached.

### Acceptance criteria

1. A conversion on a `recurring` campaign creates a **subscription** record
   linking the customer (by `customerEmailHash`) to the affiliate and campaign,
   with `remainingPeriods = recurringMonths`.
2. The brand reports subsequent billing events:
   `POST /api/conversions/:campaignId/recurring` with the original
   `externalOrderId` (or a subscription reference) and the new invoice amount.
   Same signature auth as US-05.
3. Each accepted billing event creates a new `Conversion` (order id suffixed
   `:m2`, `:m3`, …) and a new `Commission`, using the **campaign terms that
   were in force when the subscription started**, not today's. Snapshot the
   structure onto the subscription row.
4. Events beyond `remainingPeriods` are accepted and ignored with `200` and
   `{ skipped: "term_complete" }` — brands should not have to track our
   counter.
5. Cancelling a subscription (`POST .../recurring/:id/cancel`) stops future
   commissions but leaves earned ones alone.
6. Recurring commissions skip the attribution lookup entirely — attribution was
   settled by the first sale. They still go through the lock period and fraud
   scoring.
7. The affiliate's earnings view distinguishes initial from recurring revenue.

### Data model

```prisma
model Subscription {
  id                  String   @id @default(cuid())
  campaignId          String
  affiliateId         String
  trackingLinkId      String
  originalConversionId String  @unique
  customerEmailHash   String?
  externalReference   String
  commissionSnapshot  Json     // the structure in force at signup
  totalPeriods        Int
  completedPeriods    Int      @default(0)
  status              SubscriptionStatus @default(ACTIVE)
  startedAt           DateTime
  cancelledAt         DateTime?

  @@unique([campaignId, externalReference])
  @@index([affiliateId, status])
}

enum SubscriptionStatus { ACTIVE CANCELLED COMPLETED }
```

### Tests

- A 3-month term produces exactly 3 commissions across 4 reported events.
- A rate change on the campaign does not alter an in-flight subscription.
- Cancelling mid-term stops new commissions; already-earned ones survive.

### Out of scope

Proration, plan upgrades/downgrades, Stripe subscription webhooks.

---

## US-12 — Profile and payment settings

**Size** M · **Depends on** US-04

**As an** affiliate
**I want** to edit my public profile and my payout details
**so that** brands can evaluate my application and I can actually get paid.

### Context

`bio`, `socialLinks`, `avatarUrl` and `stripeConnectAccountId` are all on
`User` and none of them can be set after registration. Brands reviewing
applications see `bio` in the API response
(`brand-affiliate.repository.ts:26`) but the seed is the only thing that ever
populates it. Brands can't edit `companyName`, `companyUrl`, or `companyLogo`
either.

### Acceptance criteria

1. `GET /api/me/profile` and `PATCH /api/me/profile` return/accept the fields
   relevant to the caller's role.
2. Affiliates edit: first/last name, bio (max 2000), social links (a validated
   map of `{ platform: url }`, max 10, https only), avatar URL.
3. Brands edit: company name, company URL, company logo.
4. Changing email requires the current password and resets `emailVerified` to
   false. Changing password requires the current password and **bumps
   `tokenVersion`**, logging out other sessions.
5. Payout settings are a separate section: preferred method, and the fields
   that method needs (PayPal email; a Stripe Connect account id placeholder;
   manual = free-text bank reference).
6. A payout method must be configured before `POST /api/affiliate/payouts` will
   accept a request for that method — currently it accepts `paypal` from an
   affiliate with no PayPal address anywhere in the system.
7. The brand's Affiliates page renders the applicant's bio and social links, so
   the approve/reject decision has something to go on.

### Files to touch

- `packages/shared/src/schemas/profile.schemas.ts` *(new)*.
- `apps/api/src/services/profile.service.ts` *(new)*,
  `routes/profile.routes.ts` *(new)*, `repositories/user.repository.ts`.
- `apps/web/src/app/(affiliate)/affiliate/settings/page.tsx` *(new)*,
  `(brand)/brand/settings/page.tsx` *(new)*.

### Tests

- A password change bumps `tokenVersion`, and an old access token is then
  rejected by `requireAuth`.
- `socialLinks` rejects `http://` and `javascript:` URLs.
- Requesting a PayPal payout with no PayPal address on file → `400`.

---

# Epic D — Reporting

## US-13 — Per-campaign and per-affiliate performance tables

**Size** M · **Depends on** —

**As a** brand
**I want** to see which campaigns and which affiliates are producing
**so that** I can double down or cut.

**As an** affiliate
**I want** a per-campaign and per-link breakdown
**so that** I know where to spend my next hour.

### Context

`analyticsService` produces exactly one daily time series per role, with no
dimension breakdown. `CampaignSummary` and `AffiliateSummary` interfaces already
exist in `packages/shared/src/types/analytics.ts` — nothing populates them.
That's your target response shape; it was designed for this story.

### Acceptance criteria

1. `GET /api/brand/analytics/campaigns?days=30` returns `CampaignSummary[]`.
2. `GET /api/brand/analytics/affiliates?days=30` returns `AffiliateSummary[]`.
3. `GET /api/affiliate/analytics/campaigns?days=30` returns the affiliate's own
   `CampaignSummary[]`, plus a per-tracking-link breakdown.
4. Every table is sortable by any numeric column, server-side, with a
   whitelisted sort key — **never** interpolate a client string into SQL. The
   existing raw queries in `analytics.service.ts` use tagged-template
   parameterisation; keep that discipline.
5. Conversion rate and EPC come from the existing `safeRate` and `epc` helpers,
   so a zero denominator shows `0`/`0.00` rather than `NaN` or `Infinity`.
6. Rows link through: campaign row → campaign detail; affiliate row → that
   affiliate's relationship record.
7. Only `APPROVED` conversions count toward revenue by default, with a toggle
   to include `PENDING`. Label the toggle clearly — the difference between
   "booked" and "confirmed" revenue is a common support question.
8. Queries stay under 200 ms with 100k `ClickEvent` rows; add the indexes you
   need and say which in the PR.

### Files to touch

- `apps/api/src/services/analytics.service.ts` — new grouped queries.
- `apps/api/src/routes/analytics.routes.ts`.
- `apps/web/src/components/DataTable.tsx` *(new)* — `@tanstack/react-table` is
  already a dependency and currently unused.
- Brand and affiliate dashboards.

### Tests

- Aggregation totals match the sum of the per-row values (property-style test).
- An invalid `sort` value falls back to the default, and never reaches SQL.

---

## US-14 — Sub-ID reporting

**Size** M · **Depends on** US-02

**As an** affiliate
**I want** to tag my links with sub-IDs and see performance per tag
**so that** I can tell which placement, video or newsletter is working.

### Context

The redirect service already collects every query param that doesn't start with
`_` into `subIds`, forwards them to the destination, and the worker stores them
on `ClickEvent.subIds` as JSON (`click-event.worker.ts:53`). **Nothing reads
that column.** This is the cheapest high-value reporting feature available.

### Acceptance criteria

1. `GET /api/affiliate/analytics/subids?days=30&key=subid` returns clicks,
   conversions, revenue and commission grouped by that sub-ID value.
2. Sub-IDs are propagated from click to conversion, so revenue can be attributed
   to a tag — this requires carrying the sub-ID from the attributed
   `ClickEvent` onto the `Conversion` (denormalise it; a JSON column or a
   `subIdsSnapshot` field).
3. The affiliate links page shows a sub-ID builder: pick a link, add
   `key=value` pairs, get a copyable URL.
4. Reserved keys (anything starting `_`) are rejected in the builder with an
   explanation, matching the redirect service's filter.
5. Max 5 sub-ID keys and 100 characters per value, enforced at the edge
   (`apps/redirect`) so a malicious query string can't bloat a JSON column.
6. The sub-ID report handles the "no sub-IDs" case with a useful empty state
   explaining what they are.

### Files to touch

- `apps/redirect/src/server.ts:52` — cap key count and value length.
- `apps/api/src/services/conversion.service.ts` — snapshot sub-IDs onto the
  conversion.
- `apps/api/src/services/analytics.service.ts` — the grouped query (Postgres
  JSON operators: `ce."subIds" ->> $1`).
- `apps/web/src/app/(affiliate)/affiliate/links/page.tsx` + a new report page.

### Tests

- A click with `?subid=yt&placement=desc` produces a `ClickEvent` with both
  keys and neither `_ref`.
- A conversion attributed to that click reports revenue under `subid=yt`.
- 12 sub-ID params are truncated to 5.

---

## US-15 — CSV export

**Size** S · **Depends on** US-13

**As a** brand's finance person
**I want** to export conversions, commissions and payouts as CSV
**so that** I can reconcile against our accounting system.

### Acceptance criteria

1. Export buttons on brand conversions, affiliate earnings, and both analytics
   tables.
2. `GET /api/brand/conversions/export?status=&from=&to=` streams
   `text/csv` with `Content-Disposition: attachment`.
3. Exports respect the caller's scope exactly as the on-screen list does — a
   brand can never export another brand's rows. Reuse the same repository
   method with a different serialiser.
4. Rows stream rather than being buffered; a 50k-row export must not hold the
   whole result set in memory.
5. Dates are ISO-8601 UTC. Money is a plain decimal string, no currency symbol,
   no thousands separator.
6. Fields containing commas, quotes or newlines are properly escaped —
   **write a unit test with a campaign name of `Bob's "Big", Sale`**.
7. A formula-injection guard: values starting `=`, `+`, `-`, `@` are prefixed
   with a single quote.
8. Exports over 10k rows are rate-limited to one per minute per user.

### Files to touch

- `apps/api/src/lib/csv.ts` *(new)* — escaping + streaming helper, unit tested.
- Route handlers for each export.
- Frontend: a shared `ExportButton` component.

---

## US-16 — Date-range picker with period comparison

**Size** M · **Depends on** US-13

**As a** brand
**I want** to choose a date range and see how it compares to the previous one
**so that** I can tell whether things are getting better.

### Context

Both dashboards hardcode `?days=30`, though the API already accepts `days` up
to 90 (`analytics.routes.ts:13`).

### Acceptance criteria

1. A range picker with presets (7d, 30d, 90d, MTD, custom) on both dashboards,
   with the selection reflected in the URL query string so it survives a
   refresh and can be shared.
2. The API accepts explicit `from`/`to` ISO dates in addition to `days`;
   `days` remains supported. Maximum span 365 days.
3. Each stat tile shows the delta vs the immediately preceding equal-length
   period, as a percentage with direction, and is styled so that a *rise in
   clicks* and a *rise in conversion rate* both read as good — but colour is
   never the only signal.
4. Zero-to-something deltas render as "new", not `Infinity%`.
5. The chart can overlay the previous period as a dashed series.
6. All bucketing is UTC, matching `buildDailySeries`'s existing `eachUtcDay`.
   Do not introduce a second timezone convention; if you want local-time
   bucketing, that's a separate story with a migration plan.

### Files to touch

- `packages/analytics/src/aggregate.ts` — a `comparePeriods` pure function.
- `apps/api/src/services/analytics.service.ts` — accept a range.
- `apps/web/src/components/DateRangePicker.tsx` *(new)*, both dashboards.

### Tests

- `comparePeriods` handles zero baselines, equal periods, and shrinking values.
- A 400-day range is rejected.

---

# Epic E — Operations, safety, quality

## US-17 — Admin system health page

**Size** M · **Depends on** —

**As an** admin
**I want** one page that tells me whether the pipeline is healthy
**so that** I find out about a stalled worker before affiliates do.

### Context

The admin `NAV` array already links to `/admin/system`
(`(admin)/admin/fraud/page.tsx:9`) — **the page does not exist**, so it 404s.
Meanwhile the click worker's failure mode is silent: if a batch throws, the
events are already `RPOP`ed off the Redis list and are gone
(`click-event.worker.ts:66` logs and moves on).

### Acceptance criteria

1. `GET /api/admin/system` (admin only) returns:
   - Redis: reachable, `LLEN click_events` (queue depth), memory used.
   - Postgres: reachable, round-trip latency.
   - Click worker: timestamp of the last successful flush, count in that flush,
     count of failed batches since boot.
   - Lock-expiry worker: last run, commissions promoted in the last 24h.
   - Domain counters: pending fraud reviews, pending conversions older than 7
     days, payouts stuck in `PROCESSING` over 24h.
2. The page auto-refreshes every 15 seconds and shows each check as
   healthy/degraded/down with a plain-English explanation.
3. Queue depth over 10,000 renders as degraded; over 50,000 as down.
4. **Failed click batches are no longer lost**: on a flush failure, push the
   events back onto a `click_events_dlq` list, and surface its depth here with
   a "retry DLQ" button.
5. Workers write their heartbeats to Redis keys with a TTL, so a dead worker
   shows as stale rather than as "last seen 3 days ago" forever.
6. The endpoint is cheap — no unbounded `COUNT(*)` over `ClickEvent`. Cache the
   expensive parts for 10 seconds.

### Files to touch

- `apps/api/src/services/system.service.ts` *(new)*, `routes/admin.routes.ts`.
- Both workers — heartbeats and the DLQ path.
- `apps/web/src/app/(admin)/admin/system/page.tsx` *(new)*.

### Tests

- A worker that hasn't beaten within 3× its interval reports stale.
- A failing flush moves events to the DLQ instead of dropping them.

---

## US-18 — Bot and duplicate click filtering

**Size** M · **Depends on** US-03

**As a** brand
**I want** obvious bot traffic excluded from my click counts
**so that** my conversion rate and EPC mean something.

### Context

Every request to `/r/:shortCode` becomes a billable-looking click. A crawler, a
link-preview fetcher (Slack, iMessage, WhatsApp all prefetch), or a shopper
mashing refresh all inflate `clickCount` and deflate EPC. The only related
signal today is the fraud service's post-hoc `cookie_ip_concentration` rule.

### Acceptance criteria

1. Known bot user agents are still redirected (never break a preview) but are
   flagged and **not** counted as clicks.
2. Detection is a maintained list of UA substrings plus a `HEAD`-request check,
   living in one testable pure function.
3. Duplicate clicks — same cookie id + same tracking link within a 30-second
   window — are recorded once. Use a Redis `SET key value EX 30 NX` as the
   dedup gate; it must not add a second round-trip on the common path.
4. `ClickEvent` gains `isBot: Boolean @default(false)` and
   `isDuplicate: Boolean @default(false)`; rows are still written (we want the
   data) but excluded from analytics and from `TrackingLink.clickCount`.
5. Attribution ignores bot clicks: a conversion must not be credited to a
   crawler's click.
6. Analytics gains a "filtered traffic" line so the numbers reconcile — silently
   dropping clicks looks like a bug to affiliates.
7. The dedup window is configurable via env with a documented default.

### Files to touch

- `packages/analytics/src/bot-detection.ts` *(new)* + a table-driven test with
  real UA strings.
- `apps/redirect/src/server.ts`, `apps/api/src/workers/click-event.worker.ts`.
- `apps/api/src/services/conversion.service.ts:41` — exclude bot clicks from
  the attribution query.
- `schema.prisma` + migration + a partial index on the filtered columns.

### Tests

- Googlebot, Slackbot, curl, and a real Chrome UA classify correctly.
- Two clicks 5 seconds apart on the same cookie+link produce one counted click;
  35 seconds apart produce two.

---

## US-19 — Notifications via a transactional outbox

**Size** L · **Depends on** US-06

**As a** user of any role
**I want** to be told when something happens to me
**so that** I don't have to poll a dashboard.

### Context

There is no email, no in-app notification, no webhook — nothing. An affiliate
approved at 2am finds out whenever they next log in. Note the existing pattern
to *avoid*: `fraud.evaluate` runs **after** the conversion transaction commits
(`conversion.service.ts:146`), so a crash between the two leaves a conversion
with no fraud review and no record that one was owed. Notifications must not
inherit that hole — write the row inside the transaction.

### Acceptance criteria

1. A `Notification` outbox row is written **inside the same transaction** as
   the state change that caused it. If the transaction rolls back, no
   notification exists. This is the whole point of the story.
2. A worker polls unsent rows, delivers them, marks them sent, and retries
   failures with exponential backoff up to 5 attempts before parking them as
   `FAILED`.
3. Delivery is behind an interface with a **console driver** for dev (log the
   rendered email) and a documented seam for a real provider. Do not add an
   email vendor dependency in this story.
4. Events covered: application approved/rejected; conversion approved/rejected;
   commission unlocked; payout paid/failed; fraud review blocked (to the
   affected affiliate and the brand).
5. An in-app notification bell shows unread counts and marks-as-read.
6. Per-user preferences: each event type can be turned off, except payout and
   clawback notifications, which are mandatory (they're financial).
7. Delivery is idempotent — a worker crash mid-send must not double-send.
   Key on the notification id.

### Data model

```prisma
model Notification {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  type       String
  payload    Json
  readAt     DateTime?
  sentAt     DateTime?
  attempts   Int      @default(0)
  lastError  String?
  status     NotificationStatus @default(PENDING)
  createdAt  DateTime @default(now())

  @@index([userId, readAt])
  @@index([status, createdAt])
}

enum NotificationStatus { PENDING SENT FAILED }
```

### Tests

- Rolling back the enclosing transaction leaves zero notification rows.
- A delivery failure increments `attempts` and schedules a retry; the 6th
  failure sets `FAILED`.
- A mandatory type ignores the user's preference.

---

## US-20 — Integration test harness

**Size** L · **Depends on** —

**As an** engineer
**I want** to test routes, services and workers against a real database
**so that** I can refactor the money code without guessing.

### Context

There are four test files, all unit tests of pure functions:
`packages/analytics/src/{aggregate,attribution,commission-calc}.test.ts`,
`packages/shared/src/schemas/schemas.test.ts`, plus
`apps/api/src/lib/{errors,hash}.test.ts`. **Nothing tests a route, a Prisma
query, a transaction, or a worker.** Everything in Epic B touches money and is
currently only verifiable by hand.

### Acceptance criteria

1. `npm run test:integration` spins up a disposable Postgres (Testcontainers, or
   a documented second docker-compose service on a different port), runs
   migrations, and tears down cleanly — including after a failed run.
2. Tests use Fastify's `app.inject()` rather than binding a real port, so the
   suite is fast and parallel-safe. This requires exporting `build()` from
   `apps/api/src/server.ts` (it's currently private — refactor it out).
3. A test factory module creates users, campaigns, relationships, links, clicks
   and conversions with sensible defaults and overrides
   (`makeCampaign({ lockPeriodDays: 0 })`).
4. Each test runs in a transaction that is rolled back, or against a truncated
   schema. Tests must not depend on execution order.
5. Workers are testable directly: extract each `tick()` so a test can call it
   once instead of waiting on `setInterval`.
6. Time is injectable — no test may call `sleep`. Pass a clock or use fake
   timers, especially for the lock-expiry worker.
7. At minimum these scenarios are covered on day one:
   - Full happy path: register → apply → approve → link → click → worker flush
     → conversion → review → lock expiry → payout.
   - Cross-tenant isolation: brand A gets `403`/`404` on every one of brand B's
     resources. Assert this for **every** brand-scoped route.
   - Attribution: first/last/linear each credit the right affiliate, and the
     linear split sums to the original order value.
   - Idempotency: the same `externalOrderId` twice → `409`, one conversion row.
   - Fraud: a sub-5-second click-to-convert produces a `FLAGGED` review, and
     blocking it claws back the commission.
8. CI-ready: one command, no interactive prompts, non-zero exit on failure.

### Files to touch

- `apps/api/vitest.config.ts` *(new)* — separate `unit` and `integration`
  projects. There is currently no vitest config anywhere.
- `apps/api/test/setup.ts`, `test/factories.ts`, `test/db.ts` *(new)*.
- `apps/api/src/server.ts` — export `build()`.
- Both workers — export `tick()`.
- `package.json`, `turbo.json` — the new task.

### Notes

Fix the `DISABLE_WORKERS` coercion bug as part of this story
(`config/env.ts:15` — `z.coerce.boolean()` makes `"false"` truthy). The
integration suite needs to reliably start the API with workers off.

---

## Suggested order of play

1. **US-03** and **US-05** first — one loses money silently, the other lets
   anyone mint it. Neither depends on anything.
2. **US-01** and **US-02** next: without them a new brand cannot complete a
   single end-to-end flow through the UI.
3. **US-20** before Epic B's remaining stories. US-06, US-07 and US-08 all move
   money between states, and you do not want to verify those by hand.
4. **US-04** before any story that adds pages, so new routes are protected on
   arrival.
5. Then Epic C and D in whatever order the product needs; they're mostly
   independent.
