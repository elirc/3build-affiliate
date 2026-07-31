# Affiliate & Referral Marketing Platform

Multi-tenant platform connecting brands with affiliates: click tracking,
attribution, commissions, fraud review, and payouts.

Built story-by-story with a pull-request-per-feature workflow — see
[CONTRIBUTING.md](./CONTRIBUTING.md) for how the work is done, and
[fabledocs/](./fabledocs/) for how the system works.

## Architecture

```text
affiliate-platform/
  apps/
    web/       Next.js brand, affiliate, and admin dashboards
    api/       Fastify API for auth, campaigns, conversions, and payouts
    redirect/  Fastify redirect service for high-volume click tracking
  packages/
    shared/    Types, Zod schemas, constants, and shared utilities
    analytics/ Pure functions: attribution, commissions, state machines,
               refund maths, bot detection, period comparison
  docker-compose.yml
```

The redirect service is deliberately database-free. It is on the critical path
of every click, so it talks only to Redis and falls back to an internal API
lookup when the cache misses — it stays up while the API deploys.

## Quick Start

```bash
cp .env.example .env      # set JWT_SECRET, JWT_REFRESH_SECRET,
                          # INTERNAL_API_TOKEN, POSTBACK_ENCRYPTION_KEY
npm install
npm run db:up             # Postgres on 5452, Redis on 6389
npm run db:migrate
npm run db:seed
npm run dev
```

Ports are deliberately non-default: developers here run several stacks at once
and 5432/6379 are usually taken. They live in `docker-compose.yml` and
`.env.example` together — change both or neither.

| Service | URL |
| --- | --- |
| Web dashboard | http://localhost:3000 |
| API | http://localhost:3001 |
| Redirect service | http://localhost:3002 |

Demo accounts use `Password123!`:

- Brand: `brand@example.com`
- Affiliate: `affiliate@example.com`

There is no seeded admin — registration only accepts `BRAND` and `AFFILIATE`
by design. Insert a `User` with `role = 'ADMIN'` to get one.

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run all apps through Turborepo |
| `npm run build` | Build packages and applications |
| `npm run typecheck` | Type-check the monorepo |
| `npm run test` | Unit tests — fast, no services needed |
| `npm run test:integration` | Integration tests against real Postgres + Redis |
| `npm run db:up` / `db:down` | Start or stop Postgres and Redis |
| `npm run db:migrate` | Apply Prisma migrations |
| `npm run db:studio` | Open Prisma Studio |

The integration suite needs its own database:

```bash
docker exec affiliate-postgres createdb -U affiliate_user affiliate_dev_test
```

## Operational notes

- The API and redirect services share Redis for hot tracking-link lookups and
  click-event buffering. The redirect service resolves cache misses through
  `GET /internal/links/:shortCode` behind a 150ms timeout.
- The click worker persists events in batches. A failed batch goes to a
  dead-letter queue rather than being lost, and is replayable from
  `/admin/system`.
- Conversion reporting is idempotent by campaign and external order ID, and
  requires an HMAC signature — see
  [fabledocs/03-postback-integration.md](./fabledocs/03-postback-integration.md).
- Access tokens are checked against the user's current token version, so logout
  and a password change revoke every outstanding session.
- Bot and duplicate clicks are recorded but not counted, in totals, analytics,
  or attribution.
- In production set `WEB_ORIGIN`, strong JWT secrets, a unique `IP_SALT`, and
  keep `POSTBACK_ENCRYPTION_KEY` in a secret manager — rotating it makes every
  existing campaign API key undecryptable.

## Known limitations

Written down rather than discovered later:

- **Notifications are not delivered.** The outbox, worker, retries and
  preferences work; the driver logs to the console.
- **Uploads go to local disk**, which does not survive a second instance. The
  `ObjectStorage` interface is where S3 goes.
- **No email verification and no password reset.**
- **Refresh tokens live in `localStorage`.** They belong in an httpOnly cookie;
  the reasoning is at the top of `apps/web/src/lib/api.ts`.
- **`fraud.evaluate` runs after its transaction commits**, so a crash in
  between loses the fraud review. The outbox pattern in
  `notification.service.ts` is the fix.
