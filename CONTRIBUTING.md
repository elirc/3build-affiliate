# Contributing

This repo is deliberately run like a small professional team, because the point
is as much *how* the work gets done as *what* gets built. If you are new to
working in a shared codebase, read this once end to end before your first
branch.

---

## 1. The loop

```text
pick a story  →  branch  →  small commits  →  push  →  open a PR
     →  CI goes green  →  review  →  merge  →  delete the branch
```

Every change to `main` arrives through a pull request. There is exactly one
commit on `main` that did not: the baseline import, which had nothing to branch
from.

## 2. Branch names

`<type>/<short-kebab-description>`

| Type | Use for |
| --- | --- |
| `feat/` | New user-facing capability |
| `fix/` | A bug in existing behaviour |
| `refactor/` | Changing structure without changing behaviour |
| `chore/` | Tooling, CI, dependencies, config |
| `docs/` | Documentation only |
| `test/` | Adding or restructuring tests only |

Good: `feat/campaign-lifecycle`, `fix/redirect-cache-miss`
Bad: `my-branch`, `fixes`, `eli-work-2`

Branch from an up-to-date `main`:

```bash
git checkout main
git pull
git checkout -b feat/campaign-lifecycle
```

## 3. Commits

We use [Conventional Commits](https://www.conventionalcommits.org/). The
subject line is a **command**, not a description of what you did:

```text
feat(api): add campaign status transition endpoint
^    ^     ^
|    |     └── imperative mood: "add", not "added" or "adds"
|    └──────── scope: which part of the system
└───────────── type: feat, fix, refactor, chore, docs, test
```

Rules:

- Subject line ≤ 72 characters, no trailing full stop.
- Blank line, then a body **whenever the change is not self-evident**.
- The body explains **why**, not what. The diff already shows what.
- One logical change per commit. If you find yourself writing "and" in the
  subject line, it is two commits.

A good body answers the questions a reviewer would otherwise have to ask:

```text
fix(redirect): resolve tracking links when the Redis cache misses

The link cache was written with a 3600 second TTL and never refreshed, and the
redirect service had no path to any other source of truth. One hour after a
link was created, every click on it redirected to the global fallback URL and
was never recorded. The affiliate earned nothing and no error was raised
anywhere, which is the worst possible failure mode for a tracking system.

The redirect service still must not talk to Postgres directly -- staying
database-free is the reason it exists as a separate deployable. So the miss
path calls a new internal API endpoint instead, behind a 150ms timeout. If the
API is slow or down we fall back to the old behaviour rather than making a
shopper wait on our infrastructure problems.

Unknown short codes are negatively cached for 60 seconds so that someone
enumerating codes cannot turn each 404 into a database query.
```

### Writing multi-line messages on Windows

`git commit -m` with embedded newlines is painful in PowerShell. Write the
message to a file and use `-F`:

```bash
git commit -F .git/COMMIT_DRAFT.txt
```

## 4. Pull requests

Open one as soon as you have a commit worth showing, even if it is not
finished — mark it a draft. A PR that appears only when the work is done is a
PR nobody can influence.

The template in `.github/pull_request_template.md` is filled in, not deleted.
The sections exist because reviewers repeatedly needed that information:

- **What and why** — the reviewer may not have read the story.
- **How to verify** — exact commands. "I tested it" is not verification.
- **Trade-offs** — where you chose one approach over another, and what the
  cost is. This is the single most valuable section in a PR and the one
  juniors most often skip.
- **Risk** — what could this break? What did you deliberately not change?

Keep PRs small. A 300-line PR gets a real review; a 3,000-line PR gets an
approval that means nothing.

## 5. Definition of done

A PR is ready to merge when:

1. CI is green: `npm run typecheck`, `npm run test`, `npm run build`.
2. New behaviour has tests. New pure logic has unit tests. New routes have
   integration tests once the harness exists (see US-20).
3. Input is validated with a Zod schema from `packages/shared`.
4. Authorization is enforced in a **service**, never only in a route, and never
   only in the UI.
5. No new `any`. If you truly need an escape hatch, comment why.
6. The docs in `fabledocs/` are updated if the change makes them wrong.

## 6. Architecture rules worth memorising

These are the conventions this codebase already follows. Match them.

**The API is layered, and the layers do not skip.**

```text
routes/        Parse input. Attach preHandlers. Set status codes. No logic.
services/      The workflow. Owns transactions and authorization decisions.
repositories/  Prisma queries only. Accepts a `db` so it can run in a transaction.
lib/           Cross-cutting: auth guards, errors, hashing, logging.
```

A route must never touch `prisma` directly. A repository must never throw an
`AppError` — it does not know what the caller wanted.

**Errors are thrown, never sent.** Use `Errors.notFound('Campaign')` from
`apps/api/src/lib/errors.ts`. The single handler in `lib/error-handler.ts`
turns it into the right status and body. Inline `reply.status(400).send(...)`
bypasses that consistency and will be flagged in review.

**Pure logic goes in `packages/analytics`.** If a function can be written
without I/O, write it there with a unit test. Attribution and commission maths
live there precisely because they are the parts we most need to be sure about.

**Money is `Decimal` in Postgres, a string over the wire, and a `number` only
inside a calculation that immediately rounds to cents.** Never store money in a
float column. Never do `parseFloat` on a total and send it onward.

**Side effects that must not be lost belong in the transaction.** If a state
change implies a notification, an audit row, or an outbox entry, write it in
the same transaction as the change. Doing it afterwards means a crash in
between leaves the system inconsistent with no record that anything was owed.

## 7. Local setup

```bash
cp .env.example .env      # set JWT_SECRET and JWT_REFRESH_SECRET (20+ chars)
npm install
npm run db:up             # Postgres on 5442, Redis on 6389
npm run db:migrate
npm run db:seed --workspace=apps/api
npm run dev
```

Non-default ports are deliberate: developers on this machine run several
projects at once and the default 5432/6379 are usually already taken. The
ports live in `docker-compose.yml` and `.env.example` together — change both or
neither.

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:3001 |
| Redirect | http://localhost:3002 |

## 8. When you get stuck

Push the branch and open a draft PR with a question in the description. A
half-finished branch with a specific question gets help in minutes. Silence
for two days gets none.
