/**
 * Trending = a decaying leaderboard kept in a Redis sorted set.
 *
 * Every flush bumps each searched query's score (ZINCRBY). A background sweep
 * multiplies all scores by one interval's worth of half-life decay, so a query
 * that stops being searched fades while active ones — which keep getting bumped
 * — stay near the top. Reading the top-N is a single ZREVRANGE (O(log n + n)).
 *
 * Why a sorted set instead of "ORDER BY recent_score" on Postgres: the
 * leaderboard lives next to the cache, the read never touches the DB, and the
 * decay is a cheap periodic sweep over a capped set rather than a scan. The set
 * is trimmed to the top CAP each sweep so it can't grow without bound.
 */
import { config } from "../config";
import type { CacheCluster } from "./cache";

const KEY = "trending:zset";
const CAP = 500; // keep only the strongest N — bounds memory and sweep cost
const EPSILON = 0.01; // scores below this are dust; drop them

// how much a score shrinks over one sweep interval (half-life decay)
const DECAY_PER_SWEEP = Math.exp(
  -(Math.LN2 / config.ranking.halfLifeSec) * (config.trending.decayIntervalMs / 1000),
);

export interface TrendingEntry {
  query: string;
  score: number;
}

export class Trending {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly cache: CacheCluster) {}

  private client() {
    return this.cache.clientFor(KEY);
  }

  /** Apply a flush window of increments in one pipeline. */
  async bumpMany(window: Map<string, number>): Promise<void> {
    if (window.size === 0) return;
    const pipe = this.client().pipeline();
    for (const [query, inc] of window) pipe.zincrby(KEY, inc, query);
    await pipe.exec();
  }

  async top(n: number): Promise<TrendingEntry[]> {
    const flat = await this.client().zrevrange(KEY, 0, n - 1, "WITHSCORES");
    const out: TrendingEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push({ query: flat[i]!, score: Number(Number(flat[i + 1]).toFixed(3)) });
    }
    return out;
  }

  startDecay(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, config.trending.decayIntervalMs);
  }

  stopDecay(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Age every score, drop the dust, keep only the top CAP. */
  async sweep(): Promise<void> {
    const client = this.client();
    const flat = await client.zrange(KEY, 0, -1, "WITHSCORES");
    if (flat.length === 0) return;

    const pipe = client.pipeline();
    for (let i = 0; i < flat.length; i += 2) {
      const member = flat[i]!;
      const next = Number(flat[i + 1]) * DECAY_PER_SWEEP;
      if (next < EPSILON) pipe.zrem(KEY, member);
      else pipe.zadd(KEY, next, member);
    }
    pipe.zremrangebyrank(KEY, 0, -(CAP + 1)); // trim everything below the top CAP
    await pipe.exec();
  }
}
