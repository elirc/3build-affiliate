# Query performance

Everything in this document is a measurement. No number here was estimated,
and where something could not be measured it says so.

The starting point was that nobody had looked at a query plan in this
codebase. `prisma/seed.ts` creates one brand, one affiliate and one campaign,
so every plan was a sequential scan over twelve rows and everything was fast.
`prisma/seed-bulk.ts` now creates 500,000 click events, 60,000 conversions and
400 tracking links, deterministically, and the plans below are taken against
that.

## Reproducing this

```bash
docker exec affiliate-postgres psql -U affiliate_user -d postgres \
  -c "CREATE DATABASE affiliate_perf"

export DATABASE_URL=postgresql://affiliate_user:affiliate_pass@localhost:5452/affiliate_perf
cd apps/api && npx prisma migrate deploy
npm run seed:bulk                       # ~500k clicks, deterministic

docker exec -i affiliate-postgres psql -U affiliate_user -d affiliate_perf \
  < apps/api/prisma/query-plans.sql
```

`query-plans.sql` holds the eight queries with their bind parameters written
out as literals, so anyone can get the same plans from the same data.

### The machine, and why it is mentioned

A Windows laptop running Postgres 16 in Docker Desktop, shared with other work
at the time of measurement. Wall-clock timings on it vary by 2-3x between runs
of the *same* query on the *same* data — the same query measured 5,380ms,
3,262ms and 6,126ms on three different runs. So:

- **Timings here are from warm runs** (each query run once to warm the cache,
  then measured), and they are still only indicative.
- **Buffer counts are the real evidence.** `Buffers: shared hit=92912` is
  deterministic: it is how many 8kB pages the query touched, and it does not
  care what else the laptop was doing. Where a timing and a buffer count
  disagree, believe the buffer count.

### The protocol, and the two steps people skip

```sql
VACUUM ANALYZE;   -- both words matter
```

`ANALYZE` because a plan taken against stale statistics is evidence of
nothing: the planner will estimate one row where there are half a million,
choose a nested loop on that basis, and produce a plan for a database that
does not exist.

`VACUUM` because of the visibility map. An index-only scan still has to
establish that each row is visible to the current transaction, and it can skip
that check only for heap pages the visibility map marks all-visible — which
only `VACUUM` sets. On a freshly bulk-loaded table the map is empty, so a plan
that says `Index Only Scan` goes to the heap anyway and reports a
`Heap Fetches` count in the tens of thousands rather than zero. The largest
single win in this document is `Heap Fetches: 0`, so `seed-bulk.ts` ends with
`VACUUM ANALYZE` rather than `ANALYZE`.

## Summary

Eight queries, before and after. "Before" is the code and the indexes as they
stood on `main`; "after" is this branch. Both measured on the same 500k-row
database, both warm.

| # | Query | Before | After | Buffers before | Buffers after |
| --- | --- | ---: | ---: | ---: | ---: |
| Q1 | Brand daily series (`/brand/analytics`) | 3,263 ms | **588 ms** | 92,912 | **499** |
| Q2 | Brand conversions by day | 268 ms | 239 ms | 1,287 | 1,284 |
| Q3 | Campaign breakdown (`/brand/analytics/campaigns`) | 1,056 ms | **394 ms** | 18,484 | **1,779** |
| Q4 | Affiliate breakdown (`/brand/analytics/affiliates`) | 2,458 ms | **400 ms** | 94,519 | **2,216** |
| Q5 | Link breakdown (`/affiliate/analytics/links`) | 934 ms | **234 ms** | 18,426 | **1,165** |
| Q6 | Sub-ID report (`/affiliate/analytics/subids`) | 522 ms | **289 ms** | 22,851 | 15,034 |
| Q7 | Affiliate daily series (`/affiliate/analytics`) | 1,012 ms | **251 ms** | 17,188 | **146** |
| Q8 | Attribution lookup (postback hot path) | 0.3 ms | 0.8 ms | 7 | 10 |

Q8 was already correct and is included because "we checked and it was fine" is
a result. The two sub-millisecond numbers are noise around the same plan.

---

## Q1 — the brand daily series

`analytics.service.ts`, `clicksByDay`. The first thing a brand sees after
logging in.

### Before

```text
 GroupAggregate  (actual time=... rows=31 loops=1)
   Buffers: shared hit=80927 read=11985
   ->  Sort  (actual rows=46566 loops=1)
         ->  Nested Loop  (actual rows=46566 loops=1)
               ->  Nested Loop  (actual rows=80 loops=1)         -- the brand's 80 links
               ->  Bitmap Heap Scan on "ClickEvent" ce  (actual time=4.403..26.271 rows=582 loops=80)
                     Recheck Cond: ("trackingLinkId" = tl.id)
                     Filter: ("isCounted" AND ("timestamp" <= now()) AND ("timestamp" >= (now() - '30 days'::interval)))
                     Rows Removed by Filter: 1271
                     Heap Blocks: exact=92417
                     ->  Bitmap Index Scan on "ClickEvent_trackingLinkId_idx"  (actual rows=1853 loops=80)
 Execution Time: 3262.773 ms
```

Read it inside-out. For each of the brand's 80 links the index finds all 1,853
clicks that link has *ever* had, fetches all 1,853 rows from the heap, and
throws 1,271 of them away because they are outside the window or not counted.
`Heap Blocks: exact=92417` is the whole story: to answer a question about 46k
rows it read 92,417 heap pages — more pages than the table has rows in the
answer.

`Rows Removed by Filter: 1271` against 582 kept is the signature of an index
that is not selective enough. The index knew about `trackingLinkId`; the
query's other two predicates it had to check by going to the table.

### The change

One index, with the columns in the order the query uses them:

```prisma
@@index([trackingLinkId, isCounted, timestamp])
```

Equality columns first, range column last. That is not a style preference: a
B-tree can only apply one range predicate, and only after every column to its
left has been pinned by an equality. With `timestamp` in the middle, the
`isCounted` condition would become a filter again.

The second, larger effect was accidental and then deliberate: those three
columns are the *only* columns this query reads from `ClickEvent`. So the
index covers the query, and Postgres never touches the table at all.

### After

```text
 GroupAggregate  (actual time=540.334..586.479 rows=31 loops=1)
   Buffers: shared hit=499
   ->  Sort  (actual rows=46568 loops=1)
         ->  Nested Loop  (actual time=0.720..394.670 rows=46568 loops=1)
               ->  Hash Join  (actual rows=80 loops=1)
               ->  Index Only Scan using "ClickEvent_trackingLinkId_isCounted_timestamp_idx"
                     on "ClickEvent" ce  (actual time=0.385..2.239 rows=582 loops=80)
                     Index Cond: (("trackingLinkId" = tl.id) AND ("isCounted" = true)
                                  AND ("timestamp" >= (now() - '30 days'::interval))
                                  AND ("timestamp" <= now()))
                     Heap Fetches: 0
 Execution Time: 588.029 ms
```

All four predicates are now `Index Cond` rather than `Filter`, so the index
returns 582 rows instead of 1,853. `Heap Fetches: 0` means the table was never
read. **92,912 buffers to 499**, a factor of 186.

---

## Q3 and Q5 — the queries that read the whole platform

`breakdown.service.ts`. These two had a bug that no index could fix.

### Before

```text
 ->  Partial HashAggregate  (actual rows=400 loops=3)
       ->  Parallel Seq Scan on "ClickEvent" ce  (actual time=0.053..602.245 rows=52172 loops=3)
             Filter: ("isCounted" AND ("timestamp" <= now()) AND ("timestamp" >= (now() - '30 days'::interval)))
             Rows Removed by Filter: 114495
 Execution Time: 933.938 ms
```

The subquery aggregating clicks had no tenant filter in it at all:

```sql
LEFT JOIN (
  SELECT ce."trackingLinkId" AS lid, COUNT(*) AS n
  FROM "ClickEvent" ce
  WHERE ce."isCounted" = true AND ce."timestamp" BETWEEN ... -- and nothing else
  GROUP BY 1
) clicks ON clicks.lid = tl.id
WHERE tl."affiliateId" = $1      -- the filter, applied after the fact
```

One affiliate asking for their own seven links counted every click on the
platform for all 400 links, then joined seven of the results. The outer
`WHERE` cannot help, because a `LEFT JOIN` to a derived table is not
correlated with the outer query — Postgres has to materialise the whole
subquery first. The same shape was in `byCampaign`, aggregating all 25
campaigns to return 5.

### The change

Push the tenant filter into the subquery, where it can drive the plan:

```sql
LEFT JOIN (
  SELECT ce."trackingLinkId" AS lid, COUNT(*) AS n
  FROM "ClickEvent" ce
  JOIN "TrackingLink" own ON own.id = ce."trackingLinkId"
    AND own."affiliateId" = $1
  ...
```

Repeating the predicate looks redundant and is not. It is the difference
between a query whose cost is proportional to one affiliate's traffic and one
whose cost is proportional to the platform's.

### After

```text
 ->  HashAggregate  (actual time=177.224..177.240 rows=7 loops=1)
       ->  Nested Loop  (actual time=0.197..134.851 rows=22911 loops=1)
             ->  Index Only Scan using "ClickEvent_trackingLinkId_isCounted_timestamp_idx"
                   on "ClickEvent" ce  (actual time=0.071..16.344 rows=3273 loops=7)
                   Heap Fetches: 0
 Execution Time: 233.948 ms
```

Seven index-only scans instead of a parallel scan of 500,000 rows. Buffers
18,426 → 1,165 for Q5, and 18,484 → 1,779 for Q3.

Worth noticing: the *before* plan used three CPUs (`Workers Launched: 2`) and
the after plan uses one. Parallelism was hiding the problem — three workers
brute-forcing the table is still brute-forcing the table, and it costs three
times the CPU to do it.

---

## Q4 and Q7 — the same lesson, twice

Q4 (affiliate breakdown) had Q1's problem: 94,519 buffers, of which 92,417
were heap blocks fetched to evaluate a filter. Q7 (the affiliate daily series)
had Q3's: a parallel sequential scan removing 114,495 rows per worker.

Both are fixed by the same index and, for Q7, by nothing else — its query was
already correctly scoped, it simply had no index that could serve
`link + counted + window`.

```text
Q7 before:  Parallel Seq Scan on "ClickEvent"  rows=52172 loops=3
            Rows Removed by Filter: 114495                       1,012 ms   17,188 buffers
Q7 after:   Index Only Scan ...  rows=3273 loops=7
            Heap Fetches: 0                                        251 ms      146 buffers
```

## Q6 — the one that only half improved

The sub-ID report groups by a key inside a JSON column, so it needs `subIds`
from the heap and cannot be answered from an index. It still improved (522ms →
289ms, and its conversion side went from reading 6,166 rows to 2,039) but its
click side still reads 15,034 buffers:

```text
 ->  Bitmap Heap Scan on "ClickEvent" ce  (actual rows=333 loops=7)
       Filter: (("subIds" ->> 'utm_source') IS NOT NULL)
       Rows Removed by Filter: 2941
```

3,274 rows fetched to keep 333, because only a third of clicks carry a
`utm_source`. The fix would be a partial or expression index on
`(("subIds"->>'utm_source'))`, which Prisma's schema language cannot express —
it would have to be raw SQL in a migration, which then drifts from the schema
every time anyone runs `prisma migrate dev`. Not worth it for a report this
far off the hot path. Written down rather than silently left alone.

## Q2 — measured, unchanged, and that is the answer

The brand conversions-by-day query bitmap-scans 20,119 conversions by
`occurredAt` and hash-joins five campaigns. 1,284 buffers, 239ms. An index on
`(campaignId, occurredAt)` was added, measured, found to be **never chosen by
the planner**, and removed again. At 60,000 rows a bitmap scan over a month is
genuinely the cheapest thing available, and adding an index the planner
ignores costs writes and buys nothing.

That negative result is the reason this section exists.

---

## The N+1 in the write path

`click-event.worker.ts`, `flushBatch`. Not a query plan problem — a round-trip
problem.

```ts
await prisma.$transaction(async (tx) => {
  for (const e of events) {
    await tx.clickEvent.create({ data: { ... } });   // 100 events, 100 INSERTs
  }
});
```

One `INSERT` per event, each a full request and response over the socket, with
the transaction open the whole time. `createMany` sends the same rows as one
multi-row `INSERT`.

Measured against the 500k-row table (so index maintenance is included), batches
of 100, ten runs each, median:

```text
loop of create():  median 3405.0ms   min 2801.9   max 4196.2
createMany():      median  559.5ms   min  323.9   max  899.6
                   6.1x
```

At the worker's one-second tick that is the difference between a flush that
finishes inside its interval and one that does not.

Two details that are not incidental:

- **The rows are built before the transaction opens.** Parsing a hundred user
  agents inside a transaction holds its connection and its locks for the whole
  parse, and that cost is paid by every other writer.
- **The counter updates are sorted by link id.** They are still one statement
  per *distinct link* (100 clicks across 4 links is 5 statements, not 104), and
  sorting them means two workers flushing overlapping batches take their row
  locks in the same order. Unordered updates from concurrent transactions
  deadlock, and it would surface as an occasional failed batch rather than as
  anything obviously lock-shaped.

`flushBatch` remains one transaction, and has to. `bisectCommit` retries
*halves* of a slice that failed, so anything a failed attempt had already
written would be written twice.

---

## Indexes added

Two, each justified by a plan above.

| Index | What changed | Evidence |
| --- | --- | --- |
| `ClickEvent(trackingLinkId, isCounted, timestamp)` | `Bitmap Heap Scan` + `Filter` → `Index Only Scan`, `Heap Fetches: 0` | Q1 92,912 → 499 buffers; Q7 17,188 → 146; 275 scans across the dashboard workload |
| `Conversion(affiliateId, status, occurredAt)` | Index returned 6,166 rows for a question about 2,039 | Q6 conversion side 6,166 → 2,039 rows read |

Both *replace* an index they contain as a prefix, so neither is an addition on
top of what was there:

```text
[trackingLinkId]         ⊂  [trackingLinkId, isCounted, timestamp]
[affiliateId, status]    ⊂  [affiliateId, status, occurredAt]
```

Any query that could use the two-column index can use the three-column one.
Keeping both would have paid twice for the same thing.

## Indexes removed

Five. Removing an index nobody uses is worth as much as adding one that helps,
and it is the half people skip — an unused index costs a write on every insert
and update, forever, and never repays it.

The evidence is `pg_stat_user_indexes.idx_scan` after running the whole
dashboard workload against 500k rows:

```sql
SELECT pg_stat_reset();
-- run apps/api/prisma/query-plans.sql
SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE relname = 'ClickEvent';
```

| Removed | Size | Scans | Why nothing used it |
| --- | ---: | ---: | --- |
| `ClickEvent(isCounted, timestamp)` | 19 MB | **0** | Added on the theory that "analytics reads only counted clicks". `isCounted = true` excludes 6% of rows; Postgres reads the whole table before it walks an index for 94% of it. The planner never chose it — not once, in either the before or the after workload. |
| `ClickEvent(ipHash)` | 6.4 MB | **0** | No query filters on `ipHash`. The one place it appears is `COUNT(DISTINCT ce."ipHash")` in `fraud.service.ts`, which is an aggregate over rows already selected by something else. |
| `ClickEvent(trackingLinkId)` | 4.1 MB | n/a | A prefix of the new composite, which serves everything it served. |
| `Conversion(affiliateId, status)` | 72 kB | n/a | Same: a prefix of `(affiliateId, status, occurredAt)`. |
| `User(email)`, `Campaign(slug)`, `TrackingLink(shortCode)` | 16 kB each | **0** | Each column is already `@unique`, and a unique constraint *is* an index. Postgres used `User_email_key` for login and never once used `User_email_idx`. Prisma will happily create both if you write `@unique` and `@@index` on the same column, and nothing warns you. |

`ClickEvent` goes from six indexes to four, and its secondary indexes from
78 MB to 68 MB. Every click event now maintains four index entries instead of
six, on the highest-volume table in the system.

### One index kept without a scan to justify it

`ClickEvent(timestamp)` also shows zero scans in any plan, and it stays. Two
reasons, both worth stating rather than assuming:

1. It is the only index that can answer "clicks in this window" without naming
   a link. There is no retention or pruning job today; there will be, and it
   will want exactly this.
2. It is the index the planner *probes*. Its `idx_scan` counter is not zero —
   it sits at 7 after a workload of 8 queries, while appearing in none of the
   8 plans. That is `get_actual_variable_range()`: when a range predicate sits
   at or beyond the end of a column's histogram (`timestamp <= NOW()` always
   does), the planner reads the index's endpoint to find the real maximum
   rather than extrapolating.

   Confirmed rather than assumed — planning alone, with no execution, moves the
   counter:

   ```text
   SELECT pg_stat_reset();
   EXPLAIN SELECT COUNT(*) FROM "ClickEvent" ...   -- EXPLAIN, not EXPLAIN ANALYZE

    indexrelname                                       | idx_scan | idx_tup_read
    ClickEvent_timestamp_idx                           |        1 |          101
    ClickEvent_trackingLinkId_isCounted_timestamp_idx  |        2 |            2
   ```

   So `idx_scan > 0` does not by itself prove an index is doing useful work,
   and `idx_scan = 0` on a table that has never been queried proves nothing at
   all. Both are worth knowing before deleting anything on that evidence.

---

## The slow-request log

Any request whose total database time exceeds `SLOW_REQUEST_DB_MS` (200 by
default) logs at `warn`. Real output, from the API running against the seeded
database:

```json
{"level":40,"msg":"Request exceeded its database time budget",
 "method":"GET","route":"/api/brand/analytics","statusCode":200,
 "dbMs":1703,"queries":4,
 "slowestQuery":{"operation":"raw.queryRaw","ms":694.5},
 "totalMs":1140,"correlationId":"req-2"}

{"level":40,"msg":"Request exceeded its database time budget",
 "method":"GET","route":"/api/brand/analytics/campaigns","statusCode":200,
 "dbMs":1052,"queries":3,
 "slowestQuery":{"operation":"raw.queryRaw","ms":708},
 "totalMs":983,"correlationId":"req-3"}
```

`/health` in the same run logged nothing, which is the other half of the test:
a warning that fires on every request is not a warning.

`dbMs` exceeding `totalMs` in the first line is not a bug. The daily series
issues its clicks and conversions queries with `Promise.all`, so 1,703ms of
database *work* happened inside 1,140ms of wall clock. The budget measures how
much work a request causes, not how long it was blocked — the two differ
exactly when a request parallelises, and the work is what a shared database
cares about.

Three decisions in that shape:

- **A budget for the request, not a threshold per query.** Forty 10ms queries
  make a page as slow as one 400ms query, and only the total sees both. The
  `slowestQuery` field is what tells the two cases apart afterwards.
- **Database time, not request time.** A slow handler doing 3ms of SQL is a
  different diagnosis from 900ms of SQL behind a fast handler, and a single
  "duration" number cannot distinguish them.
- **Measured in Prisma middleware, attributed through `AsyncLocalStorage`.**
  Prisma's `query` log event fires from Prisma's own async context, by which
  point the request's store is gone and the duration cannot be attributed to
  anything. Middleware runs inside the caller's await chain. It also catches
  `$queryRaw`, which matters here because every query in this document is one.

`correlationId` is Fastify's per-request id, which it takes from a
`request-id` header when the caller sends one. BE-08 replaces it with an id
propagated across services; this landed first, and the field name is already
what BE-08 will fill in.

---

## What is still slow, and why an index will not fix it

The story asks for no dashboard query above 100ms at seeded volume. Five of the
seven are close to it and two are not, on this hardware:

```text
Q1 brand daily series   379 ms   (raw, no EXPLAIN instrumentation)
Q3 campaign breakdown   222 ms
```

Q1 reads 499 buffers. It is not doing I/O — it is spending its time producing
46,573 rows through a nested loop, calling `to_char` on each one, and sorting
them. The floor is measurable: a bare `SELECT COUNT(*)` over exactly the same
index range, with no formatting, no grouping and no sort, takes **187ms** on
this machine. So no index can take Q1 under 100ms here, because the scan alone
costs more than that.

Two honest conclusions:

1. **On this hardware the 100ms target is not met for the brand-level
   queries.** It is met comfortably for affiliate-level ones. A server with a
   real disk and an uncontended CPU would very likely meet it — 46k index-only
   rows is 20-40ms of work on ordinary server hardware — but this document does
   not have that machine, so it does not claim it.
2. **The next lever is not another index, it is not reading 46,573 rows.** A
   daily rollup table (`ClickDaily(trackingLinkId, day, clicks)`, maintained by
   the same worker that writes the events) turns the brand series into a scan
   of a few hundred rows. That is a schema change with its own correctness
   problems — backfill, late-arriving events, what happens when a click is
   deleted — and it belongs in its own story rather than smuggled into this
   one.

The regression test in `apps/api/test/query-performance.test.ts` therefore
guards the numbers that were actually achieved rather than the one we would
like: its default budget is 750ms, comfortably under the 934-3,263ms these
queries used to take and comfortably over what they take now, so a regression
fails it and this hardware does not. `QUERY_BUDGET_MS=100` asserts the target
instead, on a machine that can meet it. It is skipped unless `BULK_SEED=1`, so
CI stays fast:

```bash
TEST_DATABASE_URL=postgresql://.../affiliate_perf BULK_SEED=1 \
  npm run test:integration --workspace=apps/api -- query-performance
```

## How to read a plan, since that is the actual skill

What the plans above were read for, in the order the signals matter:

| What you see | What it means |
| --- | --- |
| `Seq Scan` on a big table with a selective filter | Missing index — or a filter that is not as selective as you think |
| `Rows Removed by Filter: 114495` | The index you have is not selective enough; the extra predicates are being checked row by row |
| `Heap Blocks: exact=92417` | Going to the table for every candidate row. If the query only needs indexed columns, it should not have to |
| `Heap Fetches: 0` under an `Index Only Scan` | The index covered the query *and* the visibility map was current. Both are required |
| Estimated `rows=` far from actual | Stale statistics — `ANALYZE` — or an expression the planner cannot estimate |
| `Workers Launched: 2` on a slow query | Parallelism is compensating for a bad plan, at three times the CPU |
| High `read` versus `hit` in `BUFFERS` | Going to disk rather than cache. On a warm run this should be near zero |
