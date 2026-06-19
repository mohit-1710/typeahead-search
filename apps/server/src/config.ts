/**
 * One place for every tunable knob. Each value backs a design decision written
 * up in docs/DESIGN.md, so the trade-offs stay tweakable from .env.
 */
import "dotenv/config";

const str = (key: string, def: string): string => process.env[key] ?? def;
const int = (key: string, def: number): number => {
  const v = process.env[key];
  return v === undefined ? def : Number.parseInt(v, 10);
};
const num = (key: string, def: number): number => {
  const v = process.env[key];
  return v === undefined ? def : Number(v);
};
const list = (key: string, def: string): string[] =>
  str(key, def)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: int("PORT", 8080),
  host: str("HOST", "0.0.0.0"),

  pg: {
    host: str("PG_HOST", "localhost"),
    port: int("PG_PORT", 5433),
    user: str("PG_USER", "typeahead"),
    password: str("PG_PASSWORD", "typeahead"),
    database: str("PG_DB", "typeahead"),
  },

  // distributed cache — one Redis per "node", routed by the hash ring
  cacheNodes: list("CACHE_NODES", "localhost:7001,localhost:7002,localhost:7003"),

  cache: {
    vnodes: int("CACHE_VNODES", 160),
    // suggestion entries are a computed top-10; a short TTL bounds staleness
    // with zero invalidation bookkeeping. jitter avoids synchronized expiry.
    ttlSuggestSec: int("TTL_SUGGEST", 45),
    ttlTrendSec: int("TTL_TREND", 8),
    ttlJitter: num("TTL_JITTER", 0.2),
  },

  buffer: {
    // entries drained per chunk. bigger chunk = more duplicates coalesced per
    // UPSERT (fewer rows + fewer transactions), at the cost of a larger window
    // held in memory while flushing. 2000 was the sweet spot in benchmarking.
    batchSize: int("BATCH_SIZE_N", 2000),
    flushIntervalMs: int("FLUSH_INTERVAL_MS", 1000),
    walKey: str("WAL_KEY", "wal:searches"),
  },

  ranking: {
    topK: int("TOP_K", 10),
    // hybrid = wPop * log1p(count) + wRec * recency
    wPop: num("W_POP", 1),
    wRec: num("W_REC", 2),
    // recency score halves after this many seconds of silence
    halfLifeSec: num("DECAY_HALFLIFE_SEC", 1800),
  },

  trending: {
    // how often the leaderboard ages its scores (same half-life as ranking)
    decayIntervalMs: int("TREND_DECAY_INTERVAL_MS", 30000),
  },
};
