# fabledocs

Engineering documentation for the Affiliate & Referral Marketing Platform.

| Doc | What it's for |
| --- | --- |
| [01-app-overview.md](./01-app-overview.md) | How the app works today: architecture, data model, the two critical request flows, conventions, and an honest list of what's missing. **Read this first.** |
| [02-user-stories.md](./02-user-stories.md) | 20 detailed user stories for the next phase of work, written to be picked up and implemented one at a time. |

## Who these are for

A junior/mid engineer joining this codebase who needs to (a) understand what
exists before changing it, and (b) ship the next set of features without having
to guess at conventions or acceptance criteria.

## Ground rules for anyone working in this repo

1. **Read `01-app-overview.md` §7 (Known Gaps) before you file a bug.** Several
   things that look broken are simply not built yet, and are already covered by
   a user story.
2. **Business logic that can be pure, goes in `packages/analytics`.** It gets a
   unit test. Attribution, commission math, and aggregation already live there.
3. **Validation lives in `packages/shared/src/schemas`** as Zod schemas, and is
   parsed at the route boundary — never deeper.
4. **Routes are thin.** `routes/*.ts` parses input, calls a service, sets a
   status code. Services own the workflow. Repositories own Prisma queries.
5. **Money is `Decimal` in Postgres, a string over the wire, and a `number`
   only inside a calculation** that immediately rounds to 2 decimals.
