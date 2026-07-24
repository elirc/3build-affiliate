# Affiliate & Referral Marketing Platform

Multi-tenant platform connecting brands with affiliates, with click tracking,
attribution, commissions, fraud review, and payout workflows.

## Architecture

```text
affiliate-platform/
  apps/
    web/       Next.js brand, affiliate, and admin dashboards
    api/       Fastify API for auth, campaigns, conversions, and payouts
    redirect/  Fastify redirect service for high-volume click tracking
  packages/
    shared/    Types, Zod schemas, constants, and shared utilities
    analytics/ Attribution, commission, and analytics helpers
  docker-compose.yml
```

## Quick Start

```bash
cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run dev
```

- Web dashboard: http://localhost:3000
- API: http://localhost:3001
- Redirect service: http://localhost:3002

Seed local demo data with:

```bash
npm run db:seed --workspace=apps/api
```

Demo accounts use `Password123!`:

- Brand: `brand@example.com`
- Affiliate: `affiliate@example.com`

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run all apps through Turborepo |
| `npm run build` | Build packages and applications |
| `npm run typecheck` | Type-check the monorepo |
| `npm run test` | Run package and app tests |
| `npm run db:up` / `npm run db:down` | Start or stop Postgres and Redis |
| `npm run db:migrate` | Apply Prisma migrations |
| `npm run db:studio` | Open Prisma Studio |

## Operational Notes

- The API and redirect services share Redis for hot tracking-link lookups and
  click-event buffering.
- The redirect service writes click events to Redis first, then the API worker
  persists them to Postgres in batches.
- Conversion reporting is idempotent by campaign and external order ID.
- Access tokens are checked against the user's current token version, so logout
  revokes existing sessions.
- In production, set `WEB_ORIGIN`, strong JWT secrets, and a unique `IP_SALT`.
