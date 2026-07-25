# GPT Code Review Findings

Review date: 2026-07-25  
Scope: `apps/api`, `apps/redirect`, `apps/web`, `packages/shared`, `packages/analytics`, Prisma schema/migrations, tests, and CI configuration.

## Executive summary

The project has a solid foundation: tenant and role checks are consistently applied to protected API routes, input schemas cover most write operations, postbacks use raw-body HMAC verification, payout creation uses a database advisory lock, uploaded images are inspected by content, and the codebase has meaningful unit and integration coverage.

The highest-priority risks are:

1. Long-lived refresh tokens are readable by browser JavaScript.
2. The installed production dependency tree contains five high-severity vulnerable packages.
3. A fraud rule calculates IP concentration across an entire affiliate/campaign instead of the cookie being scored, allowing suspicious traffic to evade that signal.
4. Concurrent conversion reversals can apply the same paid-commission clawback more than once.

No application code was changed as part of this review.

## Findings

### CR-01 — High: refresh tokens are exposed to any same-origin script

Evidence:

- [`apps/web/src/lib/api.ts`](../apps/web/src/lib/api.ts) stores both the access token and the 30-day refresh token in `localStorage`.
- [`apps/api/src/services/auth.service.ts`](../apps/api/src/services/auth.service.ts) accepts the same refresh token repeatedly until it expires or the user's global `tokenVersion` changes.

Impact:

Any XSS, compromised third-party script, or malicious browser extension with page access can extract a credential that remains useful for up to 30 days. Because refresh tokens are not rotated, stealing one once is enough to mint new access tokens repeatedly. Logging out revokes every session for the user, but there is no per-session revocation or stolen-token reuse detection.

Recommendation:

- Put the refresh token in a `Secure`, `HttpOnly`, appropriately scoped `SameSite` cookie.
- Keep the access token in memory rather than persistent browser storage.
- Rotate refresh tokens on every use and persist a hashed session/token-family record.
- Revoke the token family when an already-rotated token is reused.
- Add CSRF protection if the final cookie and cross-site deployment configuration requires it.

### CR-02 — High: installed production dependencies have known high-severity advisories

Evidence:

`npm audit --omit=dev` reported 5 high-severity vulnerable packages and 0 critical packages:

| Installed package | Path | Reported risk |
| --- | --- | --- |
| `fast-uri@3.1.2` | Fastify/AJV dependency | Host-confusion vulnerabilities |
| `find-my-way@9.6.0` | Fastify router dependency | HTTP/2 denial of service |
| `postcss@8.5.10` | Next.js dependency | Arbitrary file/source-map disclosure |
| `sharp@0.34.5` | Next.js image dependency | Inherited libvips vulnerabilities |
| `next@16.3.0-canary.6` | Direct web dependency | Audit parent for affected transitive packages |

Relevant manifests:

- [`apps/api/package.json`](../apps/api/package.json)
- [`apps/web/package.json`](../apps/web/package.json)
- [`package-lock.json`](../package-lock.json)

Impact:

The routing issue is remotely triggerable when the service is exposed over HTTP/2. The URL parsing and source-map issues can affect security decisions or disclose files when attacker-controlled inputs reach the affected functionality. Running a canary Next.js build also makes patch selection and upgrade stability less predictable.

Recommendation:

- Upgrade Fastify and its locked transitive dependencies to versions containing patched `find-my-way` and `fast-uri` releases.
- Move the web app from the canary Next.js line to a supported stable release that includes patched PostCSS and Sharp dependencies.
- Do not blindly accept the audit tool's suggested Next.js downgrade; select a compatible patched version, rebuild, and rerun the full test suite.
- Add `npm audit --omit=dev` or an equivalent dependency scanner to CI with an explicit exception process.

### CR-03 — High: the IP-concentration fraud signal is scoped to the wrong traffic

Evidence:

In [`apps/api/src/services/fraud.service.ts`](../apps/api/src/services/fraud.service.ts), `clickCount` is correctly restricted to `ctx.attributionCookieId`, but `uniqueIps` is calculated across every click for the affiliate and campaign during the previous 24 hours. The rule fires only when:

```text
clickCount for this cookie > 5 AND unique IPs for the whole affiliate/campaign <= 1
```

Impact:

As soon as an affiliate has ordinary traffic from two or more IPs, a cookie with many clicks from one IP no longer triggers the concentration signal. On an active campaign this effectively disables that part of fraud scoring, reducing the chance that suspicious conversions reach the review threshold.

Recommendation:

Filter the IP query by the same `attributionCookieId` being evaluated. Prefer one grouped query that returns both click count and distinct IP count for the same campaign, affiliate, cookie, time window, and counted-traffic policy. Add a test where the suspicious cookie uses one IP while unrelated campaign traffic uses multiple IPs.

### CR-04 — High: concurrent paid-conversion reversals can double-charge an affiliate

Evidence:

[`apps/api/src/services/conversion.service.ts`](../apps/api/src/services/conversion.service.ts) reads the conversion and commission status before opening the transaction. The transaction then updates by ID without conditionally claiming the expected state.

Two concurrent full-refund requests can therefore both:

1. Read the conversion as `APPROVED`.
2. Read the commission as `PAID`.
3. Enter separate transactions.
4. Create separate negative `BalanceAdjustment` rows for the same refund.

The review endpoint has the same check-then-update shape, allowing concurrent approve/reject requests to emit conflicting notifications and race on final state.

Impact:

A retried or duplicated refund request can deduct the same commission twice from a future payout. This is a direct monetary-integrity issue.

Recommendation:

- Claim the conversion inside the transaction with a conditional update such as `WHERE id = ? AND status = 'APPROVED'`, and require an affected-row count of exactly one.
- Add a refund idempotency key or a unique reversal record keyed by conversion and external refund ID.
- Lock or conditionally claim the commission state in the same transaction.
- Apply the same pattern to conversion review (`PENDING` to a final state).
- Add concurrency integration tests for duplicate full refunds, partial refunds, and simultaneous approve/reject requests.

### CR-05 — Medium: one bad click event can quarantine up to 99 valid events indefinitely

Evidence:

[`apps/api/src/workers/click-event.worker.ts`](../apps/api/src/workers/click-event.worker.ts):

- Treats any JSON object as a `ClickEventPayload`; there is no runtime schema validation.
- Flushes as many as 100 events in one database transaction.
- On any insert/update failure, moves the entire batch to the dead-letter list.
- Replays dead letters unchanged, so a poison event can fail the same group repeatedly.

A stale tracking-link ID, invalid date, missing required field, or incompatible producer can cause this path.

Impact:

One poison message delays valid click attribution, counters, analytics, and downstream conversions in the same batch. Because replay is manual and does not isolate the failing record, recovery can repeatedly re-quarantine valid events.

Recommendation:

- Validate every queue message with a shared runtime schema before batching.
- Move invalid events individually to the DLQ with an error reason.
- If a database batch fails, isolate the failing message (for example, by recursively splitting the batch) while committing valid messages.
- Add DLQ depth/age monitoring and an operator-visible replay workflow.
- Add tests for missing tracking links, invalid timestamps, and mixed valid/invalid batches.

### CR-06 — Medium: several request paths bypass runtime validation

Evidence:

- [`apps/api/src/routes/tracking.routes.ts`](../apps/api/src/routes/tracking.routes.ts) casts the link-toggle body instead of validating `isActive`.
- [`apps/api/src/routes/campaign.routes.ts`](../apps/api/src/routes/campaign.routes.ts) converts public pagination values with `Number()` without checking for `NaN`, negative values, or a maximum page size.
- [`apps/api/src/routes/conversion.routes.ts`](../apps/api/src/routes/conversion.routes.ts) does the same for brand conversion pagination and passes an unrestricted status string to the repository.
- [`apps/api/src/routes/relationship.routes.ts`](../apps/api/src/routes/relationship.routes.ts) accepts an unrestricted relationship status query that is later cast to a Prisma enum.

Impact:

Malformed requests can become Prisma errors and 500 responses instead of clear 400 responses. Very large public page sizes can also cause expensive reads and oversized responses.

Recommendation:

Define and use Zod schemas for every body and query path. Pagination should use bounded positive integers (for example, `page >= 1` and `1 <= pageSize <= 100`), and filter values should be enums. Add negative-path route tests.

## Verification performed

| Check | Result |
| --- | --- |
| TypeScript checks for API, redirect, web, analytics, and shared projects | Passed |
| Unit tests | 208 passed across 26 files |
| Web production build | Passed; all 23 routes generated |
| `npm audit --omit=dev` | Failed: 5 high, 0 critical |
| Full API integration suite | Did not complete within a 5-minute local run |
| Targeted `happy-path` integration file | 2 passed, 1 transient foreign-key failure |
| Previously failing targeted integration case in isolation | Passed |

The transient integration failure suggests test-database interference or isolation flakiness rather than a confirmed application defect. Re-run the full suite in CI or against a freshly created, dedicated test database before using that result as a release signal.

The root Turbo typecheck command also produced no diagnostics before timing out twice in this environment, while every project-level TypeScript check passed. That points to task-runner/process orchestration rather than a TypeScript error.

## Suggested order of work

1. Make conversion reversal idempotent and concurrency-safe.
2. Correct the fraud query and add the missing regression test.
3. Move refresh tokens to rotated, server-managed cookie sessions.
4. Upgrade the vulnerable production dependency tree.
5. Isolate poison click events and add DLQ observability.
6. Close the remaining request-validation gaps.
7. Stabilize the local Turbo and integration-test workflows.

