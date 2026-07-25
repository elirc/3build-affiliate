# The Affiliate Platform, explained

> Audience: an engineer who has never seen this repo. By the end you should be
> able to trace a click from a browser to a paid commission, and know which file
> to open for any given change.

---

## 1. What the product is

This is a **two-sided affiliate marketing platform**, like ShareASale, Impact,
or PartnerStack.

- **Brands** run *campaigns* (a.k.a. programs). A campaign says: "promote this
  landing page, and I'll pay you 20% of every sale you send me, as long as the
  sale happens within 30 days of the click."
- **Affiliates** (bloggers, YouTubers, coupon sites) apply to a brand, get
  approved, and generate **tracking links** — short URLs like
  `http://localhost:3002/r/k7m2xq9`.
- When a shopper clicks that link, we record a **click event**, drop an
  attribution cookie, and forward them to the brand's site.
- When the shopper buys, the **brand's own server** calls our API to report a
  **conversion**. We look back at the clicks tied to that shopper's cookie,
  decide which affiliate earned it (**attribution**), and compute a
  **commission**.
- Commissions sit **locked** for a hold period (so refunds can be handled),
  then become payable, then get bundled into a **payout**.
- A rules engine scores each conversion for **fraud**; suspicious ones land in
  an admin review queue.

The three actors map exactly to the three `UserRole` values: `BRAND`,
`AFFILIATE`, `ADMIN`.

---

## 2. Repository layout

A [Turborepo](https://turbo.build/) monorepo with npm workspaces.

```text
buildaffiliate/
├── apps/
│   ├── api/        Fastify REST API — the brain. Owns Postgres + background workers.
│   ├── redirect/   Tiny Fastify service that ONLY does /r/:shortCode redirects.
│   └── web/        Next.js 16 App Router dashboards for all three roles.
├── packages/
│   ├── shared/     Zod schemas, TypeScript types, constants. Imported by all three apps.
│   └── analytics/  Pure functions: attribution, commission math, daily aggregation.
├── docker-compose.yml   Postgres 16 + Redis 7
└── turbo.json           Task graph (build / dev / test / typecheck)
```

### Why the redirect service is separate

Redirects are the highest-volume, lowest-value request in the system. Every
click hits it; a click must resolve in single-digit milliseconds; and it must
stay up even if the API is being deployed or the database is under load.

So it is deliberately crippled:

- It talks to **Redis only** — never to Postgres, never to Prisma.
- It writes clicks to a Redis list (`LPUSH click_events`) and returns
  immediately. It does not wait for a database write.
- The `.catch(() => {})` on that push at `apps/redirect/src/server.ts:72` is
  intentional: losing a click is better than making a shopper wait.

The API's `click-event.worker.ts` drains that list into Postgres a second later.
This is the classic "fast path writes to a queue, slow path persists" pattern.

### Package boundaries that matter

- `@affiliate/shared` is consumed as **raw TypeScript source**
  (`"main": "./src/index.ts"`), not a build artifact. Next.js is told to
  compile it via `transpilePackages` in `apps/web/next.config.mjs:4`. That's
  why you can edit a schema and see it apply everywhere without rebuilding.
- `@affiliate/analytics` contains **only pure functions**. No Prisma, no Redis,
  no `Date.now()` sprinkled around. That is what makes it trivially unit
  testable, and it is why every function there has a test file next to it.

---

## 3. The stack, and where each piece is configured

| Concern | Choice | File |
| --- | --- | --- |
| API framework | Fastify 5 | `apps/api/src/server.ts` |
| ORM | Prisma 5 → Postgres 16 | `apps/api/prisma/schema.prisma` |
| Cache / queue | Redis 7 via ioredis | `apps/api/src/config/redis.ts` |
| Auth | `@fastify/jwt` access tokens + hand-rolled HMAC refresh tokens | `apps/api/src/services/auth.service.ts` |
| Password hashing | argon2id | `apps/api/src/lib/hash.ts` |
| Validation | Zod, shared between client and server | `packages/shared/src/schemas/` |
| Logging | pino (pretty in dev) | `apps/api/src/lib/logger.ts` |
| Frontend | Next.js 16 App Router + React 18 | `apps/web/` |
| Server state | TanStack Query v5 | `apps/web/src/app/providers.tsx` |
| Charts | Recharts | `apps/web/src/components/AnalyticsChart.tsx` |
| Styling | Tailwind 3 with a `brand-*` colour scale | `apps/web/tailwind.config.ts` |
| Tests | Vitest | co-located `*.test.ts` files |

---

## 4. The data model

Read `apps/api/prisma/schema.prisma` alongside this section.

```text
User (BRAND | AFFILIATE | ADMIN)
 │
 ├─(brand)──── Campaign ──── CreativeAsset
 │                │
 │                ├──── TrackingLink ──── ClickEvent
 │                │            │               │
 │                │            └──── Conversion ◄┘
 │                │                      │
 │                │                      ├──── Commission ──── Payout
 │                │                      └──── FraudReview
 │
 └─(affiliate)─ BrandAffiliate (the join between a brand and an affiliate)
```

### The models, in plain language

**`User`** — one table for all three roles, with role-specific columns hanging
off it (`companyName` for brands, `bio`/`socialLinks` for affiliates). It's a
pragmatic choice for an app this size; the cost is a lot of nullable columns.
`tokenVersion` is the session-revocation counter (see §5).

**`BrandAffiliate`** — the relationship, keyed `@@unique([brandId, affiliateId])`.
Note what it is **not** keyed by: campaign. An affiliate applies to a *brand*,
and once approved can build links on **any** of that brand's active campaigns.
The API accepts a `campaignId` when applying purely so the public program page
has something to put a button on — see the comment at
`apps/api/src/services/relationship.service.ts:7`.

**`Campaign`** — the commercial terms. The important fields:

- `commissionStructure` — a JSON blob, validated by a Zod discriminated union
  (`packages/shared/src/schemas/campaign.schemas.ts:4`). Four shapes:
  `flat_per_sale`, `percentage`, `tiered_percentage`, `recurring`.
- `attributionModel` — `FIRST_CLICK`, `LAST_CLICK` (default), or `LINEAR`.
- `attributionWindowDays` — how far back we look for clicks when a sale lands.
- `cookieLifetimeDays` — how long the browser cookie survives.
- `lockPeriodDays` — the refund hold. A commission can't be paid until this
  many days after the sale.
- `isOpen` — if true, affiliate applications auto-approve.
- `allowedDomains` — a whitelist. An affiliate cannot point a tracking link at
  an arbitrary URL; the destination hostname must match or be a subdomain of
  one of these (`apps/api/src/services/tracking.service.ts:40`).

**`TrackingLink`** — an affiliate × campaign pair with a `shortCode`. Carries
**denormalised counters** (`clickCount`, `conversionCount`, `revenue`) that
workers increment. They are eventually consistent by design — do not treat them
as an audit source, use `ClickEvent`/`Conversion` for that.

**`ClickEvent`** — one row per click, written in batches by the worker. IP is
stored as a **salted SHA-256 prefix**, never raw (`hashIP` in
`apps/redirect/src/server.ts:86`).

**`Conversion`** — a reported sale. `@@unique([campaignId, externalOrderId])`
is the idempotency guarantee: the brand's store can retry its webhook safely.

**`Commission`** — money owed to an affiliate for a conversion. This is the
state machine you'll spend the most time thinking about:

```text
                   ┌──────────────────────────────────────┐
   (created)──► LOCKED ──lock period elapses & conversion  │
                   │      approved──► APPROVED ──► INCLUDED_IN_PAYOUT ──► PAID
                   │
                   ├── brand rejects the conversion ──► REJECTED
                   └── admin blocks it for fraud ──► CLAWED_BACK
```

> ⚠️ The enum also contains `PENDING`, but **nothing ever creates a commission
> in that state** — `conversion.service.ts:122` creates them as `LOCKED`
> immediately. The affiliate "Pending" earnings card therefore always reads
> `$0.00`. Don't "fix" it by guessing; see US-06.

**`Payout`** — a batch of approved commissions, with `amount` (gross),
`feeAmount` (the platform's cut, `PLATFORM_FEE_PERCENT`, default 5%), and
`netAmount`.

**`FraudReview`** — a risk score plus the signals that produced it. Created
only when at least one rule fires (`fraud.service.ts:109`).

---

## 5. Authentication

Two token types, deliberately different:

- **Access token** — a real JWT signed by `@fastify/jwt`, 15-minute TTL,
  carries `{ id, role, tokenVersion }`.
- **Refresh token** — hand-rolled: base64url header + body + HMAC-SHA256
  signature, 30-day TTL (`auth.service.ts:31`). Verified with
  `crypto.timingSafeEqual` to avoid timing leaks.

`requireAuth` (`apps/api/src/lib/auth.ts:10`) does three things on every
protected request: verify the JWT, **re-read the user from Postgres**, and
reject if `role` or `tokenVersion` has changed. That last check is the whole
logout story — `logout` just increments `tokenVersion`, which instantly
invalidates every outstanding access token for that user. The price is one
extra database round-trip per request.

`requireRole('BRAND')` is a second `preHandler` that runs after `requireAuth`.
Order matters; they're always registered as an array in that order.

**On the frontend**, the access token is kept in a module variable plus
`localStorage` (`apps/web/src/lib/api.ts:14`). There is currently no refresh
logic and no route protection — see §7.

---

## 6. The two flows you must understand

### 6.1 A click

```text
Shopper clicks https://links.example.com/r/k7m2xq9
        │
        ▼
apps/redirect  GET /r/:shortCode
        │  1. GET link:k7m2xq9 from Redis
        │     └─ miss, or isActive === false → 302 to DEFAULT_FALLBACK_URL
        │  2. read/mint the `attribution_id` cookie (httpOnly, lax,
        │     maxAge = campaign.cookieLifetimeDays)
        │  3. collect sub-IDs from the query string (any param not starting `_`)
        │  4. LPUSH click_events {...}   ← fire and forget
        │  5. 302 to destinationUrl + ?_ref=<cookieId> + sub-IDs
        ▼
apps/api  click-event.worker.ts   (every 1000ms)
        │  RPOP up to 100 events  ← LPUSH + RPOP = FIFO
        │  parse the UA into device/browser/os (ua-parser-js)
        │  one transaction: INSERT ClickEvents + increment TrackingLink.clickCount
        ▼
Postgres: ClickEvent rows
```

The Redis entry is written when the link is created
(`tracking.service.ts:63`) and rewritten when it's toggled active/inactive,
with a **3600-second TTL**. Remember that number; it matters (§7, US-03).

### 6.2 A conversion

```text
Brand's storefront, after checkout:
  POST /api/conversions/:campaignId
  { externalOrderId, conversionValue, attributionCookieId, customerEmail?, occurredAt? }
        │
        ▼
apps/api  conversion.service.ts → report()
  1. Load campaign. 404 if missing.
  2. Duplicate check on externalOrderId (also matches the "orderid:affiliateId"
     suffix form used for split attribution) → 409.
  3. Find ClickEvents for that cookie, on this campaign, inside
     [occurredAt - attributionWindowDays, occurredAt].
     No clicks → 422 "No attributable clicks found".
  4. attribute(model, clicks)  ← packages/analytics/src/attribution.ts
        FIRST_CLICK → 100% to the earliest click
        LAST_CLICK  → 100% to the latest click
        LINEAR      → equal split across unique tracking links
  5. In ONE transaction, per share:
        count this affiliate's prior APPROVED conversions on this campaign
        calculateCommission(structure, value × share, priorCount)
        INSERT Conversion (status PENDING)
        INSERT Commission (status LOCKED, lockExpiresAt = occurredAt + lockPeriodDays)
        increment TrackingLink.conversionCount / revenue
  6. After the transaction: fraud.evaluate() per conversion.
        ▼
Brand reviews it in the UI → POST /api/brand/conversions/:id/review
        approved → Conversion APPROVED
        rejected → Conversion REJECTED + all its Commissions REJECTED
        ▼
apps/api  lock-expiry.worker.ts   (every 60s)
        find LOCKED commissions whose lockExpiresAt has passed
        promote to APPROVED **only if the parent Conversion is APPROVED**
        ▼
Affiliate requests a payout → POST /api/affiliate/payouts
        bundles all APPROVED commissions → Payout(PENDING),
        commissions → INCLUDED_IN_PAYOUT
```

Two details worth internalising:

- **Split attribution rewrites the order id.** With `LINEAR` and two
  affiliates, one incoming order becomes two `Conversion` rows with
  `externalOrderId` of `order-123:affA` and `order-123:affB`, because the
  unique index is `(campaignId, externalOrderId)`
  (`conversion.service.ts:99`). That's why the duplicate check uses a
  `startsWith` prefix match as well as an exact match.
- **Tiered commissions read history.** `priorAffiliateSalesCount` is counted
  *inside* the transaction, so a tier boundary is evaluated against approved
  sales at the moment of the sale, not at payout time.

---

## 7. Layering and conventions in the API

```text
routes/        Parse input with a Zod schema. Attach preHandlers. Set status codes.
               Zero business logic.
services/      The workflow. Owns transactions, orchestration, and authorization
               checks that need data ("is this campaign yours?").
               Exported as a factory: `export function campaignService() { ... }`
repositories/  Prisma queries only, one per aggregate. Takes `db: DB` so it can
               be handed a transaction client.
lib/           Cross-cutting: auth guards, error types, hashing, logging.
config/        Env parsing (Zod), Prisma client, Redis client.
workers/       setInterval loops. Started from server.ts unless DISABLE_WORKERS.
```

**Errors.** Throw `Errors.notFound('Campaign')` etc. from
`apps/api/src/lib/errors.ts`; the single error handler in
`lib/error-handler.ts` turns `AppError` into `{ error: { code, message } }`
with the right status, turns `ZodError` into a 400 with the issue list, and
turns anything else into a logged 500. **Never** `reply.status(...).send(...)`
an error inline.

**Ownership checks are the service's job.** e.g.
`campaignService.getById(brandId, id)` loads the campaign and throws
`Errors.forbidden()` if `brandId` doesn't match. The route never sees the
comparison. Follow this pattern — it is the only thing standing between one
brand and another brand's data.

**Frontend conventions.**

- Route groups mirror roles: `(public)`, `(brand)`, `(affiliate)`, `(admin)`.
  The parenthesised folder does not appear in the URL.
- Every page is `'use client'`. There is no server-side data fetching yet.
- Data via `useQuery`/`useMutation` with `api()` from `@/lib/api`, which
  attaches the bearer token and throws `HttpError`.
- After a mutation, `queryClient.invalidateQueries({ queryKey: [...] })`.
- `DashboardShell` takes a `title` and a `NAV` array. **The NAV array is
  duplicated at the top of every page file** and they have already drifted —
  `affiliate/links/page.tsx` is missing the "My Applications" entry.

---

## 8. Known gaps — read before filing a bug

These are *not built*, rather than broken. Each maps to a user story in
[02-user-stories.md](./02-user-stories.md).

| # | Gap | Consequence | Story |
| --- | --- | --- | --- |
| 1 | ~~Campaigns are created as `DRAFT` and **no UI can activate them**~~ **FIXED** | Was: a brand could create a campaign and hit a dead end. The detail page now offers only the legal transitions, and the rules live in `packages/analytics/src/campaign-lifecycle.ts` | US-01 ✅ |
| 2 | ~~The affiliate "Tracking Links" page is read-only~~ **FIXED** | Was: the endpoints existed but nothing in the UI called them. There is now a create form, a copy button and an active/paused toggle | US-02 ✅ |
| 3 | ~~Redis link cache has a **1-hour TTL and no rehydration**~~ **FIXED** | Was: one hour after a link was created, every click 302'd to `DEFAULT_FALLBACK_URL` and earned nothing. The redirect service now resolves misses via `GET /internal/links/:shortCode` and repopulates the cache — see `apps/redirect/src/link-resolver.ts` | US-03 ✅ |
| 4 | No route protection, no token refresh in the web app | Any URL renders for a logged-out user (with failing queries); after 15 minutes a logged-in user silently starts getting 401s. `POST /api/auth/refresh` exists but nothing calls it | US-04 |
| 5 | ~~`POST /api/conversions/:campaignId` is **unauthenticated**~~ **FIXED** | Was: anyone on the internet could fabricate sales against any campaign. Now requires an HMAC signature from a per-campaign API key, with a 5-minute replay window — see [03-postback-integration.md](./03-postback-integration.md) | US-05 ✅ |
| 6 | ~~Payouts never leave `PENDING`~~ **PARTLY FIXED** (US-06 done, US-07 pending) | Was: no admin route moved a payout to `PAID`, so "Paid lifetime" was permanently `$0.00`. Admin process/complete/fail/cancel routes now exist with a `PayoutEvent` audit trail, plus affiliate payout history. Concurrency hardening is still open | US-06 ✅, US-07 |
| 7 | No refund/clawback path for an *approved* conversion | `CLAWED_BACK` is only reachable via admin fraud-block | US-08 |
| 8 | `BrandAffiliate.customCommission` is never read | Per-partner rates are impossible | US-09 |
| 9 | `CreativeAsset` has a table and no API or UI | Affiliates have no banners to use | US-10 |
| 10 | `recurring` commissions pay once | `recurringMonths` is stored and ignored (`commission-calc.ts:42`) | US-11 |
| 11 | No profile/settings page | `bio`, `socialLinks`, `avatarUrl`, `stripeConnectAccountId` are unreachable after signup | US-12 |
| 12 | Analytics is one global time series per role | `CampaignSummary`/`AffiliateSummary` types exist in `shared` but nothing produces them — no per-campaign or per-affiliate breakdown | US-13 |
| 13 | Sub-IDs are captured and never surfaced | `ClickEvent.subIds` is written by the worker and read by nothing | US-14 |
| 14 | No CSV export anywhere | Finance teams live in spreadsheets | US-15 |
| 15 | Dashboards are hardcoded to 30 days | The API already accepts `?days=` up to 90 | US-16 |
| 16 | `/admin/system` is in the admin nav but the page doesn't exist | 404 for admins | US-17 |
| 17 | No bot filtering or click dedup at the edge | A refresh-happy shopper or a crawler inflates click counts and craters EPC | US-18 |
| 18 | Zero notifications | Nobody is told their application was approved or their payout was sent | US-19 |
| 19 | No integration tests | 4 unit test files cover pure functions only; nothing exercises a route, the DB, or a worker | US-20 |
| 20 | `emailVerified` is set by the seed and never by a flow; no password reset | — | (not scheduled) |

### Traps that have already bitten people

- ~~**`DISABLE_WORKERS` doesn't work the way it reads.**~~ **FIXED.** It was
  parsed with `z.coerce.boolean()`, and `Boolean("false") === true`, so
  `DISABLE_WORKERS=false` *disabled* the workers. Now parsed by
  `boolFromString` in `config/env-parsers.ts`, which accepts only `"true"` or
  `"false"` and rejects anything else at boot.
- ~~**There is no `prisma/migrations/` directory.**~~ **FIXED.** The initial
  migration is committed. `npm run db:migrate` from the repo root applies it.
- ~~**Nothing loads `.env`.**~~ **FIXED.** This was never in the original list
  because it was found while verifying setup: no package depended on `dotenv`
  and `env.ts` read `process.env` directly, so the documented
  `cp .env.example .env` did nothing. The dev/start scripts now pass Node's
  `--env-file-if-exists=../../.env`.
- **The repo has no `node_modules` on a fresh clone.** Run `npm install` first.
- **Two different list-response shapes.** `/api/brand/campaigns` returns
  `{ items, total, page, pageSize }`; `/api/brand/conversions`,
  `/api/affiliate/links`, `/api/brand/affiliates` return bare arrays. Check
  before you destructure.
- **The dev/prod CORS split** in `server.ts:26` allows *any* origin outside
  production. Fine locally, dangerous if `NODE_ENV` is ever wrong.

---

## 9. Running it

```bash
cp .env.example .env      # then set JWT_SECRET / JWT_REFRESH_SECRET (min 20 chars)
npm install
npm run db:up             # docker: postgres:5432, redis:6379
npm run db:migrate        # creates prisma/migrations on first run
npm run db:seed --workspace=apps/api
npm run dev               # turbo runs all three apps
```

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:3001 (`GET /health`) |
| Redirect | http://localhost:3002 (`GET /health`) |

Seeded logins, password `Password123!`:
`brand@example.com`, `affiliate@example.com`. There is **no seeded admin** —
create one by inserting a `User` with `role = 'ADMIN'` (registration only
accepts `BRAND`/`AFFILIATE`, by design).

The seeded campaign `acme-affiliate-2026` is already `ACTIVE`, which is the
only reason the demo flow works at all today (see gap #1).

```bash
npm run test        # vitest across shared + analytics + api
npm run typecheck   # tsc --noEmit everywhere
npm run build
```

### Exercising the full loop by hand

```bash
# 1. Log in as the affiliate, create a link on the seeded campaign
curl -s localhost:3001/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"affiliate@example.com","password":"Password123!"}'

curl -s localhost:3001/api/affiliate/links -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"campaignId":"<id>","destinationUrl":"https://acme.example.com/pricing"}'

# 2. Click it (keep the cookie jar — you need the attribution_id)
curl -s -i -c jar.txt "localhost:3002/r/<shortCode>?subid=newsletter"

# 3. Wait ~1s for the click worker, then report a sale as the brand's server
curl -s localhost:3001/api/conversions/<campaignId> -H 'content-type: application/json' \
  -d '{"externalOrderId":"order-1","conversionValue":149.99,"attributionCookieId":"<from jar.txt>"}'
```

If step 3 returns `422 No attributable clicks found`, the click worker hasn't
flushed yet (or `DISABLE_WORKERS` bit you — see §8).

---

## 10. Where to start reading

1. `apps/api/prisma/schema.prisma` — the whole domain in 370 lines.
2. `packages/analytics/src/attribution.ts` + `commission-calc.ts` — the two
   pieces of real business logic, both pure, both tested.
3. `apps/api/src/services/conversion.service.ts` — the most important workflow
   in the app.
4. `apps/api/src/workers/lock-expiry.worker.ts` — the comment at the top is the
   best single description of the commission state machine.
5. `apps/web/src/app/(brand)/brand/campaigns/new/page.tsx` — the most complex
   form, and the template for any new one.
