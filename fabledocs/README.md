# fabledocs

Engineering documentation for the Affiliate & Referral Marketing Platform.

| Doc | What it's for |
| --- | --- |
| [01-app-overview.md](./01-app-overview.md) | How the app works: architecture, data model, the two critical request flows, and conventions. Section 8 records what was wrong when the codebase was inherited and where each thing was fixed. **Read this first.** |
| [02-user-stories.md](./02-user-stories.md) | The 20 stories that were built, with the acceptance criteria and trade-offs each was judged against. Now a record rather than a backlog — see the status note at the top. |
| [03-postback-integration.md](./03-postback-integration.md) | For a brand's engineers: how to sign and send conversion reports. Written to be shared outside this repo. |
| [04-backend-stories.md](./04-backend-stories.md) | Ten backend-depth stories (BE-01 … BE-10) chosen for what they teach: token rotation, idempotency, poison messages, keyset pagination, webhook delivery, query plans, leader election, observability, rate limiting, streamed imports. **This is the current backlog.** |

## Where the project stands

All twenty feature stories are on `main`, each through its own pull request.
The current backlog is [04-backend-stories.md](./04-backend-stories.md) — ten
stories aimed at backend depth rather than features. Several of them fix
problems that are already latent in the code: every API instance runs its own
`setInterval` workers (BE-07), one malformed click event can cost 99 good ones
(BE-03), and refresh tokens are never rotated (BE-01).

Start at
the [pull request list](https://github.com/elirc/3build-affiliate/pulls?q=is%3Apr)
if you want the reasoning behind a particular decision — every PR carries a
"Trade-offs" section explaining what was chosen and what it cost.

```text
120 unit tests
153 integration tests   (real Postgres + Redis)
```

`npm run test` for the fast ones, `npm run test:integration` for the rest.

**Still open**, and written down rather than glossed over:

- No email verification and no password reset (gap 20).
- Notifications are enqueued, retried and surfaced in the UI, but the delivery
  driver logs to the console — nothing reaches an inbox.
- Uploads go to local disk, which does not survive a second instance.
- `fraud.evaluate` still runs *after* its transaction commits, so a crash in
  between loses the fraud review. US-19 demonstrates the outbox pattern that
  fixes it.

## Who these are for

An engineer joining this codebase who needs to (a) understand what exists
before changing it, and (b) ship the next thing without guessing at
conventions.

## Ground rules for anyone working in this repo

1. **Read `01-app-overview.md` §8 before you file a bug.** Several things that
   look odd are deliberate, and the section says why.
2. **Business logic that can be pure, goes in `packages/analytics`.** It gets a
   unit test. Attribution, commission maths, the state machines, refund
   arithmetic and bot detection all live there because they are the parts we
   most need to be sure about.
3. **Validation lives in `packages/shared/src/schemas`** as Zod schemas, and is
   parsed at the route boundary — never deeper.
4. **Routes are thin.** `routes/*.ts` parses input, calls a service, sets a
   status code. Services own the workflow and the authorization decisions.
   Repositories own Prisma queries.
5. **Money is `Decimal` in Postgres, a string over the wire, and a `number`
   only inside a calculation** that immediately rounds to two decimals. Use
   `apps/api/src/lib/money.ts` on the way out.
6. **A side effect that must not be lost belongs in the transaction.** If a
   state change implies a notification or an audit row, write it in the same
   transaction. Doing it afterwards means a crash in between leaves the system
   inconsistent with no record that anything was owed.
