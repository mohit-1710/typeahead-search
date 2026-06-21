# Design notes & trade-offs

The system runs two workloads over one dataset: **reads** (suggestions, fired on
every keystroke) and **writes** (a count bump on every submitted search). Reads
outnumber writes by roughly 5–10×, and a suggestion is allowed to be a little stale.
Almost every decision below follows from those two facts — make reads cheap, keep
writes off the hot path, and lean on the idea that *roughly popular* is good enough.

It is one TypeScript service (Fastify) sitting in front of an in-memory **trie**
(the index), three **Redis** nodes (the shared cache), and **PostgreSQL** (the
source of truth). Every knob that controls a trade-off lives in
[`apps/server/src/config.ts`](../apps/server/src/config.ts), so the choices stay
easy to tune.

---

## 1. Serving suggestions — a trie with cached top-K at each node

A keystroke needs the top 10 searches that start with a prefix. Two obvious ideas,
and why I skipped them:

- **`LIKE 'prefix%'` on Postgres per keystroke** — a range scan plus a sort, on
  every keystroke. Fine at low traffic, falls over under load. The database should
  not be on this path at all.
- **A plain trie that walks the whole subtree per read** — correct, but a broad
  prefix like `"a"` walks a huge subtree every single time.

So every trie node caches the **top 25 completions** found anywhere in its subtree,
ordered by count. A lookup is then just: walk the letters of the prefix
(`O(prefix length)`) and read the list that is already sitting there. **No subtree
scan on the read path.** That is the whole point — keystrokes are reads, and reads
have to be cheap.

This stays affordable because **counts only ever go up**. When a count rises I walk
that one query up its own path and slot it into each ancestor's list. A query
already near the top can only stay or climb. All of that work runs on the write
side, which is batched and off the hot path, never on a read. The list keeps a few
more than the 10 I serve, so the recency re-rank has spare candidates without going
back to the tree.

**Trade-off:** a list on every node costs memory. At 100–200k queries that is
comfortable in RAM. Past ~1M I would keep these lists only for short, hot prefixes
and fall back to a bounded walk for the deep ones. The monotonic-count assumption
holds *within a process* and resets cleanly on a restart, since the trie is rebuilt
from Postgres.

## 2. Ranking — `count` vs `recency`

Two ways to order results:

- **`count`** — sort by the all-time count. Stable, the sensible default.
- **`recency`** — blend popularity with freshness:

  ```
  score = wPop · log(count) + wRec · recencyScore
  ```

  `recencyScore` **halves every 30 minutes** of silence (exponential decay), so a
  query spiking *now* can jump a bigger but stale one, and a short burst fades on
  its own instead of ranking forever. The `log(count)` keeps the huge counts from
  drowning out the recency term.

Decay is applied at read time from the score's last-touched timestamp, so a query
that goes quiet keeps sliding down without any background pass.

## 3. Why cache at all — the Pareto argument

Search popularity is **Zipf** — a small set of prefixes serves most of the traffic.
So caching the hot set gives a high hit rate and keeps the trie and the database out
of most reads. Roughly: ~10M daily users × ~4 searches/day ≈ a few hundred writes/s
on average and a few thousand suggestion reads/s, with higher peaks. Those hot
prefixes repeat all day, which is exactly what a cache is good at. On a realistic
read mix the measured hit rate is **~99%** (see [PERFORMANCE.md](PERFORMANCE.md)).

## 4. One shared cache, spread across nodes

- **Local (per app instance) vs global → global.** A shared cache is one copy and
  one place things expire. Per-instance caches duplicate the hot set and need extra
  work to stay in sync.
- **Single Redis vs distributed (3 nodes) → distributed.** One node could hold this
  data and QPS with ease. I spread it for **fault tolerance** and headroom, not raw
  throughput. If one node dies I lose 1/3 of the cache — those prefixes just miss to
  the trie and refill, rather than the whole cache going cold at once. The app tier
  is stateless, so it scales behind a plain load balancer.

## 5. Routing — consistent hashing

The cache lives on three nodes, so I need a rule that always sends one prefix to the
**same** node. If a prefix went to different nodes on different reads, a value cached
on node A would look like a miss when the next read lands on node B. That rules out
round-robin straight away — it forgets where a key went.

The simplest rule that works is `hash % N`. It is steady until `N` changes, and then
almost every key moves and the cache goes cold. A **hash ring** fixes this: it remaps
only about `1/N` of keys when a node joins or leaves, which is the real reason to use
it. I also place many **virtual nodes** per server on the ring so no single server
owns an oversized arc by chance.

For the hash itself I use **MurmurHash3** (32-bit). It is fast, dependency-free, and
has a proper avalanche step at the end. I started with FNV-1a and the near-identical
node ids (`node#0`, `node#1`, …) landed close together and threw the balance off by
100%+. Murmur scatters them, and the measured spread is within **~15%** of even
across three nodes. A crypto hash would also work, but I am placing keys, not
defending against an attacker, so it would only cost cycles. The same ring also
places the single-key structures — the write-ahead log and the trending set — so
everything routes one way.

## 6. Eviction — `volatile-lru`

Redis is set to **`volatile-lru`**: only keys that carry a TTL are eligible for
eviction. This is deliberate. The suggestion entries have a TTL, so they can be
evicted, and LRU keeps the hot prefixes while dropping the rare long tail. The
write-ahead log and the trending set carry **no TTL**, so they are never evicted. One
setting protects the important data and caps memory at the same time. `appendonly` is
on, so those no-TTL structures also survive a restart.

## 7. Invalidation — write-around + short, jittered TTL

- **Write-around.** A submitted search updates the store and the trie, **not** the
  cache. The cache refills lazily on the next miss. A cached value is a computed
  top-10, and most count bumps do not change that list, so recomputing on every write
  would be wasted work.
- **Short TTL** (~45s) bounds staleness with zero tracking. It is **jittered** (±20%)
  so a burst of fills does not all expire on the same tick and stampede the trie
  together.
- **No targeted invalidation.** One count change can stale many prefixes — every
  prefix of the query, across nodes. Tracking and busting them all is real complexity
  that the short TTL already covers, so I left it out on purpose.

## 8. Writes — a durable WAL, then batched upserts

`POST /search` has to be fast and must **not lose counts**. So a search does one
thing: it appends to a Redis list (the write-ahead log) and replies `Searched` right
away. The counting happens in the background.

A drainer reads that list in batches — **on an interval, or as soon as the list hits
the batch size, whichever comes first** — coalesces the duplicates into one
`query → count` map, and applies a single **additive upsert**:

```sql
count = count + EXCLUDED.count   -- racing flushes add instead of clobbering
```

The same batch also updates the trie and the trending set, then trims the part of
the log it just handled.

Two wins from one design:

- **Batching** collapses thousands of searches into a handful of DB writes — measured
  **~7.6× fewer rows** and **~1800× fewer transactions** ([PERFORMANCE.md](PERFORMANCE.md)).
- **Durability** — because the log lives in Redis (`appendonly`), an un-drained
  window **survives a crash** and the drainer just replays it on restart.

I process the batch **before** trimming, so a crash mid-flush replays a batch (**at
least once**) rather than dropping it. For popularity counts a rare double-count is
harmless, while *losing* writes would be the real bug. This is the one place I went
past the obvious in-memory buffer, which is **at most once** — it loses its last
window on a crash.

**Trade-off:** one extra Redis round-trip per search, and counts that lag by a flush
interval (~1s). Both are fine — writes are the minority workload and the counts are
explicitly an estimate.

## 9. Trending — a decaying sorted set

Trending is a leaderboard that fades. It lives in a Redis **sorted set** (`ZSET`).
Each flush bumps the searched queries' scores (`ZINCRBY`). A sweep every 30s
multiplies every score by one interval's worth of the same half-life, so a query
nobody is searching slowly sinks while active ones — which keep getting bumped —
stay near the top. Reading the top-N is a single `ZREVRANGE`, and it **never touches
Postgres**. The set is trimmed to the strongest ~500 so it cannot grow without
bound.

I picked a sorted set over `ORDER BY recent_score` on Postgres because the
leaderboard then sits next to the cache, the read stays off the database, and the
decay is a cheap periodic sweep over a small set rather than a scan.

## 10. Store — PostgreSQL

The workload *looks* write-heavy, which usually argues for a write-optimised store.
But the batching already cut DB writes ~7×, so that pressure is gone, and I would
rather have what Postgres gives for free: a `text_pattern_ops` index that serves a
`LIKE 'prefix%'` range scan if I ever need a DB fallback, exact counts, and easy read
replicas. The trie and the cache are both rebuildable from this one table, so
Postgres only has to be **correct**, never fast on the read path. I would reach for
an LSM store (Cassandra) only if writes were un-batchable and huge, or I needed
sharding plus quorums.

## 11. Consistency — eventual (PA/EL)

The suggestion counts are an estimate of popularity, so staleness is harmless while
latency and availability are not. During a partition I would rather serve a slightly
stale suggestion than error (**AP**), and in normal running I serve from the cache
rather than re-check the DB (**EL**). The `Searched` reply is a synchronous
*acknowledgement*, not a promise that Postgres is already updated.

---

## Summary

| Topic | Decision | Rejected |
|---|---|---|
| Serving | trie + per-node cached top-K (`O(prefix)`) | DB `LIKE` per keystroke; subtree walk per read |
| Ranking | `count`, plus a decayed `recency` blend | a raw recent counter that over-ranks spikes |
| Caching | cache the reads | no cache → reads bound to the trie/DB |
| Locality | one shared cache | a cache per instance → duplication + drift |
| Topology | three nodes | one node → bigger blast radius on failure |
| Routing | consistent hashing, MurmurHash3 + virtual nodes | round-robin (no locality); `% N` (mass remap); FNV-1a (clustered) |
| Eviction | `volatile-lru` (only TTL'd keys) | `allkeys-lru` (would evict the WAL + trending) |
| Invalidation | write-around + short, jittered TTL | write-through (costly); targeted (complex) |
| Writes | durable WAL + coalesced batch upsert | in-memory buffer (loses a window on a crash) |
| Trending | decaying Redis sorted set | `ORDER BY recent_score` scan on Postgres |
| Store | PostgreSQL | NoSQL/LSM (not needed once writes are batched) |
| Consistency | eventual / PA-EL | strong (costs latency + availability) |

## Known limits

- A single very hot prefix still lands on one node (the **hot-key** problem). Spreading
  it would need hot-key replication or a small L1 in front of each app instance.
- A crash can double-count at most one un-trimmed flush window — I favour not losing
  writes over avoiding a rare double.
- The per-node lists trade memory for read speed. Past ~1M queries I would cap them by
  depth (see §1).
- Counts lag the live WAL by a flush interval (~1s), which is fine for an estimate of
  popularity.
