# Design decisions & trade-offs

The system runs two workloads over one dataset: **reads** (suggestions, fired on
every keystroke) and **writes** (a count bump on every submitted search). Reads
dominate, roughly 5–10 to 1, and suggestion data tolerates being a little stale.
Almost every decision below follows from those two facts: make reads cheap, keep
writes off the hot path, and lean on the fact that "approximately popular" is good
enough.

The whole thing is one TypeScript service (Fastify) in front of an in-memory
trie, a 3-node Redis cache, and Postgres. Knobs live in `apps/server/src/config.ts`.

---

## 1. Serving suggestions: a trie with per-node cached top-K

A keystroke needs the top-10 completions of a prefix. Two obvious options and why
I rejected them:

- **Query Postgres with `LIKE 'prefix%'` on every keystroke** — a range scan plus
  a sort, per node, per keystroke. It works at low traffic and falls over under
  load. The DB shouldn't be on the read path at all.
- **A plain trie that DFS-walks the subtree on each read** — correct, but a broad
  prefix like `"a"` walks a huge subtree every time.

Instead each trie node caches the **top 25 completions in its subtree**, ordered
by count. A lookup is then: walk the prefix (O(prefix length)) and read the
node's list. **No subtree walk on the read path.**

The reason that's affordable: **search counts only ever go up.** When a query's
count rises, I walk its own prefix path and bubble it into each ancestor's cached
list; something already on top can only stay or climb. So maintenance is
O(prefix length × list size) per updated query, paid on the (batched, off-path)
write side — never on a read.

**Trade-off:** a list on every node costs memory. At 100–200k queries that's
comfortably in RAM. Past ~1M I'd cap the cached lists by depth (only shallow,
hot prefixes) and fall back to a bounded walk for deep prefixes — the classic
precompute-the-hot-set move. I chose the simpler "cache everywhere" because it
keeps reads uniformly O(prefix length) at this scale. The list holds 25 (> the 10
served) so the recency re-rank has spare candidates without re-walking.

## 2. Ranking: `count` vs `recency`

- **count** — sort by all-time count. Stable, the default.
- **recency** — re-rank the node's cached list by `wPop·log1p(count) + wRec·recent`.
  `recent` is a score that **halves every 30 min of silence** (exponential decay),
  so a query spiking right now can jump a bigger but stale one, and a short burst
  fades on its own instead of ranking forever. `log1p(count)` keeps the
  power-law-large counts from drowning out the recency term.

Decay is applied at read time from the score's last-update timestamp, so a query
that went quiet keeps dropping without needing a sweep.

## 3. Why a cache at all (the Pareto argument)

Query popularity is Zipf — a small set of prefixes serves most of the traffic. So
caching the hot set gives a high hit rate and keeps the trie/DB off most reads.
Concretely, ~10M DAU × ~4 searches/day ≈ a few hundred writes/s and a few
thousand suggestion reads/s, peaking higher; the hot prefixes repeat constantly,
which is exactly what a cache is good at. Measured hit rate on a Zipf read mix is
**~99%** (see PERFORMANCE.md).

## 4. Cache topology: global and distributed

- **Local (per-app-instance) vs global → global.** A shared cache is one copy and
  one place things expire. Per-instance caches duplicate the hot set and need
  cross-instance invalidation to stay coherent.
- **Single Redis vs distributed (3 nodes) → distributed.** One node would handle
  this dataset and QPS fine; the reason to split is **fault tolerance and
  headroom**. If one node dies we lose 1/3 of the cache (those prefixes just miss
  to the trie and refill) rather than stampeding the whole hot set. The app tier
  itself is stateless, so it scales with a plain load balancer.

## 5. Routing: consistent hashing

Cache nodes hold different keys, so routing has to be **deterministic per key** —
the same prefix must always land on the same node, or a value cached on node A is
a miss when the next read routes to node B. That immediately rules out
round-robin (it forgets where a key went).

`hash % N` is deterministic but remaps almost every key when `N` changes. A
**hash ring with virtual nodes** remaps only ~1/N of keys when a node joins or
leaves — the property that makes scaling the cache non-disruptive. Virtual nodes
(160 points per server) smooth the distribution so no single server owns an
oversized arc.

- **Hash: MurmurHash3 (32-bit).** Fast, dependency-free, and it has a proper
  avalanche finalizer — I started with FNV-1a and the near-identical vnode ids
  (`node#0`, `node#1`, …) clustered badly, throwing the distribution off by 100%+.
  Murmur's finalizer scatters them; measured spread is within ~15% of even across
  3 nodes. (A crypto hash would work too but we're placing keys, not defending
  against an adversary, so it'd only cost cycles.)
- The ring also routes the single-key structures (the write-ahead log, the
  trending leaderboard) so *everything* uses one deterministic placement.

## 6. Eviction: `volatile-lru`

Redis is configured `volatile-lru`: only keys **with a TTL** are eligible for
eviction. That's deliberate — the suggestion cache entries carry a TTL so they
can be evicted under memory pressure (LRU keeps the hot prefixes, drops the long
tail), while the write-ahead log and the trending set carry **no TTL** and are
therefore never evicted. One policy protects durability and bounds memory at the
same time. `appendonly` is on so those no-TTL structures survive a restart.

## 7. Invalidation: write-around + short jittered TTL

- **Write-around.** A submitted search updates the store and the trie, **not the
  cache**. The cache refills lazily on the next read miss. I avoided
  write-through because a cache value is a computed top-10 and most count bumps
  don't change that list — recomputing on every write is wasted work.
- **Short TTL** (45s suggestions) bounds staleness with zero tracking. It's
  **jittered** (±20%) so a burst of fills doesn't all expire on the same tick and
  stampede the trie.
- **Targeted invalidation was deliberately skipped.** A single count change can
  stale many prefix entries (every prefix of the query, across nodes); tracking
  and busting them is real complexity that the short TTL already covers.

## 8. Writes: a durable write-ahead log + batched upsert

`POST /search` must be cheap **and** must not lose counts. So a search does one
thing: append its query to a Redis list (the WAL) and return `Searched`. The
count never touches Postgres on the request path.

A background drainer then, on an interval, reads the log in chunks, **coalesces
duplicates** into a single `query → count` map, applies **one additive UPSERT**
to Postgres (`count = count + EXCLUDED.count`, so racing flushes add instead of
clobbering), applies the same increments to the live trie and the trending set,
and trims the log.

Two wins from one structure:
- **Batching.** Thousands of searches collapse into a handful of DB writes —
  measured ~7.6× fewer rows and ~1800× fewer transactions (PERFORMANCE.md).
- **Durability.** Because the buffer lives in Redis (appendonly), an un-drained
  window **survives a crash** — the drainer just replays it on restart.

I process **before** trimming, so a crash mid-flush replays a batch (**at-least
once**) rather than dropping it. For approximate popularity counts, a rare double
count is harmless; *losing* writes would be the actual bug. This is the one place
I deliberately went further than the obvious in-memory buffer, which is
**at-most-once** — it loses its last window on a crash.

**Trade-off:** the WAL adds one Redis round-trip per search and the counts are a
flush-interval behind. Both are fine: writes are the minority workload, and the
counts are explicitly allowed to be approximate.

## 9. Trending: a decaying Redis sorted set

Trending is a **leaderboard that decays**. Each flush bumps the searched queries'
scores (`ZINCRBY`); a sweep every 30s multiplies all scores by one interval's
worth of the half-life, so queries nobody is searching fade while active ones —
which keep getting bumped — stay near the top. Reading the top-N is a single
`ZREVRANGE`, and the set is trimmed to the top 500 so it can't grow unbounded.

I picked a sorted set over "`ORDER BY recent_score` on Postgres" because the
leaderboard then lives next to the cache, the read never touches the DB, and the
decay is a cheap periodic sweep over a small capped set instead of a scan.

## 10. Store: PostgreSQL

The workload looks write-heavy, which usually argues for a write-optimized
LSM/NoSQL store. But the batch buffer already cut DB writes ~7×, so that pressure
is gone, and I'd rather have the things Postgres gives for free: a B-tree
(`text_pattern_ops`) that serves `LIKE 'prefix%'` as a range scan if I ever need
a DB fallback, exact counts, and easy read replicas. The trie and cache are both
rebuildable from this table, so Postgres only has to be **correct**, never fast on
the read path. I'd reach for an LSM store (Cassandra) only if writes were
un-batchable and enormous, or I needed sharding + quorum.

## 11. Consistency: eventual, PA/EL

Suggestion data is approximate popularity, so staleness is harmless but latency
and availability are not. During a partition I'd rather serve a slightly stale
suggestion than error (**AP**), and in normal operation I serve from cache rather
than re-check the DB (**EL**). The `Searched` response is a synchronous
*acknowledgement*; the durable count update behind it is asynchronous.

---

## Summary

| Topic | Decision | Rejected alternative |
|---|---|---|
| Serving | trie + per-node cached top-K (O(prefix) reads) | DB `LIKE` per keystroke; DFS per read |
| Ranking | count + decayed recency blend | raw recent counter (over-ranks spikes) |
| Caching | cache reads | no cache → DB/trie-bound under load |
| Locality | global | per-instance → duplication + coherence |
| Topology | distributed (3 nodes) | single → bigger blast radius on failure |
| Routing | consistent hashing, murmur3 + 160 vnodes | round-robin (no locality); `%N` (mass remap); FNV-1a (clustered) |
| Eviction | `volatile-lru` (only TTL'd keys) | `allkeys-lru` (would evict the WAL/trending) |
| Invalidation | write-around + short jittered TTL | write-through (costly); targeted (complex) |
| Writes | durable WAL + coalesced batch upsert | in-memory buffer (at-most-once, loses a window) |
| Trending | decaying Redis sorted set | `ORDER BY recent_score` scan on Postgres |
| Store | PostgreSQL | NoSQL/LSM (unneeded once writes are batched) |
| Consistency | eventual / PA-EL | strong (latency + availability cost) |

## Known limits

- A single scorching-hot prefix still lands on one node (the hot-key problem) —
  it would need hot-key replication or a small per-instance L1 in front.
- A crash can double-count at most one un-trimmed flush window (at-least-once).
- The trie's per-node lists trade memory for read speed; past ~1M queries I'd cap
  them by depth (see §1).
- Counts are a flush interval (~1s) behind the live WAL — acceptable for
  approximate popularity.
