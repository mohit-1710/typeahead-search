/**
 * Write-behind buffer with a durable WAL.
 *
 * POST /search must be cheap and must not lose counts. So a search appends its
 * query to a Redis list (the write-ahead log) and returns immediately — the
 * count never touches Postgres on the request path. A background drainer reads
 * the log in batches, coalesces duplicates in memory, applies one additive
 * UPSERT to Postgres and the same increments to the live trie, then trims the
 * log.
 *
 * Two wins in one: batching collapses thousands of searches into a handful of
 * DB writes, and because the log is in Redis (appendonly), an un-drained window
 * survives a crash — the drainer just replays it on restart. We process *before*
 * trimming, so a crash mid-flush double-counts a batch at worst (at-least-once),
 * never drops it. Approximate popularity counts happily tolerate the rare double;
 * losing writes would be the real bug. (A naive in-memory buffer is at-most-once
 * — it loses the last window on a crash.)
 */
import { config } from "../config";
import type { CacheCluster } from "./cache";
import { counters } from "./metrics";
import type { Store } from "./store";
import type { Trending } from "./trending";
import type { CompletionTrie } from "./trie";

export function coalesce(batch: string[]): Map<string, number> {
  const window = new Map<string, number>();
  for (const q of batch) window.set(q, (window.get(q) ?? 0) + 1);
  return window;
}

export interface BufferDeps {
  cache: CacheCluster;
  store: Store;
  trie: CompletionTrie;
  trending: Trending;
}

export class WriteBuffer {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private readonly key = config.buffer.walKey;

  constructor(private readonly deps: BufferDeps) {}

  /** Append-and-ack. One Redis RPUSH, routed by the ring like every other key. */
  async record(query: string): Promise<void> {
    const q = query.toLowerCase().trim();
    if (!q) return;
    counters.searchesReceived++;
    await this.deps.cache.clientFor(this.key).rpush(this.key, q);
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.drain();
    }, config.buffer.flushIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drain(); // final drain so nothing is left buffered
  }

  async drain(): Promise<void> {
    if (this.draining) return; // never run two drains at once
    this.draining = true;
    try {
      const client = this.deps.cache.clientFor(this.key);
      for (;;) {
        const batch = await client.lrange(this.key, 0, config.buffer.batchSize - 1);
        if (batch.length === 0) break;

        const window = coalesce(batch);
        await this.deps.store.batchUpsert(window); // durable, additive
        this.deps.trie.applyIncrements(window); // keep the live index in sync
        await this.deps.trending.bumpMany(window); // feed the leaderboard
        await client.ltrim(this.key, batch.length, -1); // drop what we processed

        if (batch.length < config.buffer.batchSize) break; // log drained
      }
    } finally {
      this.draining = false;
    }
  }

  /** Current depth of the WAL (for /metrics). */
  async pending(): Promise<number> {
    return this.deps.cache.clientFor(this.key).llen(this.key);
  }
}
