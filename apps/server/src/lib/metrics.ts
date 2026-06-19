/** Mutable process counters + latency samples behind GET /metrics. Reset on
 *  restart — operational signals for the demo, not durable analytics. */
export const counters = {
  cacheHits: 0,
  cacheMisses: 0,
  dbWrites: 0, // rows written via batch flush
  dbWriteBatches: 0, // flush round-trips to Postgres (the batching win)
  searchesReceived: 0, // POST /search calls, before coalescing
};

export function recordHit(): void {
  counters.cacheHits++;
}

export function recordMiss(): void {
  counters.cacheMisses++;
}

// --- /suggest latency, kept in a bounded ring buffer (ms) ---
const LAT_CAP = 5000;
const latency: number[] = [];
let latWrite = 0;

export function recordLatency(ms: number): void {
  if (latency.length < LAT_CAP) latency.push(ms);
  else {
    latency[latWrite] = ms;
    latWrite = (latWrite + 1) % LAT_CAP;
  }
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return Number(sorted[idx]!.toFixed(3));
}

export interface SnapshotExtra {
  trieSize: number;
  walPending: number;
  cacheNodes: number;
}

export function snapshot(extra: SnapshotExtra) {
  const lookups = counters.cacheHits + counters.cacheMisses;
  const hitRate = lookups ? Number((counters.cacheHits / lookups).toFixed(4)) : 0;
  // write reduction = searches received vs rows actually written to Postgres
  const writeReduction = counters.dbWrites
    ? Number((counters.searchesReceived / counters.dbWrites).toFixed(2))
    : null;

  return {
    cacheHits: counters.cacheHits,
    cacheMisses: counters.cacheMisses,
    cacheHitRate: hitRate,
    dbReads: 0, // suggestions are served from cache/trie — the DB is never on the read path
    dbWrites: counters.dbWrites,
    dbWriteBatches: counters.dbWriteBatches,
    searchesReceived: counters.searchesReceived,
    writeReductionFactor: writeReduction,
    suggestLatencyMs: {
      samples: latency.length,
      p50: percentile(latency, 50),
      p95: percentile(latency, 95),
      p99: percentile(latency, 99),
    },
    trieSize: extra.trieSize,
    walPending: extra.walPending,
    cacheNodes: extra.cacheNodes,
  };
}
