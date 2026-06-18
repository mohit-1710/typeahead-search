/** Mutable process counters behind GET /metrics. Reset on restart — these are
 *  operational signals for the demo, not durable analytics. */
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
