# Performance

**Setup:** one Fastify node, one Postgres, three Redis nodes (all Docker, on a
laptop). **Dataset:** 150k synthetic Zipf queries. **Reproduce:** start the stack,
load the data, run `pnpm bench` (drives the live API and reads `/metrics`).

```bash
pnpm bench --reads 8000 --writes 20000
```

The numbers below are a representative run. Latency is single-process on a
laptop, so treat the *shape* (cache hit → microseconds, DB off the read path,
big write reduction) as the point, not the absolute req/s.

## Read latency — `GET /suggest`

| | p50 | p95 | p99 |
|---|---|---|---|
| server-side | 0.38 ms | 0.65 ms | 0.84 ms |
| client-side (incl. HTTP) | 1.2 ms | 2.6 ms | 5.1 ms |

- **DB reads on the suggestion path: 0.** A cache hit is one Redis GET; a miss is
  an O(prefix length) trie lookup. Postgres is never touched to answer a keystroke.
- ~22k suggestion req/s from a single client process against one server.

## Cache hit rate

- **99.4%** over 8,000 reads (7,948 hits / 52 misses) on a Zipf prefix mix.
- The misses are almost entirely cold-start (first time each hot prefix is seen);
  once warm the hot set stays resident. A flatter (less realistic) read mix would
  lower this; real search traffic is *more* skewed than the synthetic mix, which
  would push it higher.

## Write reduction — batching

20,000 submitted searches in one run:

| Searches received | Rows written to Postgres | Flush transactions |
|---|---|---|
| 20,000 | 2,642 | 11 |

- **~7.6× fewer rows** (duplicate coalescing per flush window) and **~1,800× fewer
  transactions** (batching) than writing each search through synchronously.
- The lever is the drain chunk size (`BATCH_SIZE_N`, default 2000): a bigger chunk
  coalesces more duplicates per UPSERT. At chunk size 500 the reduction was ~3.4×;
  2000 brought it to ~7.6× — see the commit history.
- Cost of the trade: counts are a flush interval (~1s) behind, and a crash can
  replay at most one un-trimmed window (at-least-once). Durability comes from the
  WAL living in Redis (appendonly), so an un-drained window is **never lost**.

## Consistent hashing — distribution

6,000 sample keys across 3 nodes (160 virtual nodes each):

```
localhost:7001  1943
localhost:7002  1883
localhost:7003  2174
```

Within ~15% of perfectly even (2,000 each). Adding or removing a node remaps only
~1/N of keys rather than nearly all of them (the reason for the ring over `% N`) —
verified by the unit test in `src/lib/hashRing.test.ts`. Per-key routing is
inspectable live via `GET /cache/debug?prefix=<p>`.

## Index build

- 150k queries built into the trie in **~350 ms** at startup, from Postgres.
- The trie is rebuilt from the DB on boot and kept live by the flush drainer, so
  it never drifts from the source of truth.

## Reproduce

```bash
docker compose up -d
pnpm install
pnpm --filter @ta/server load            # 150k synthetic queries
pnpm --filter @ta/server start           # server on :8080
pnpm --filter @ta/server bench           # the report above
curl 'http://localhost:8080/metrics'     # live counters
curl 'http://localhost:8080/cache/ring?sample=6000'
```
