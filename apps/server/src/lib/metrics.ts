/** Mutable process counters behind GET /metrics. Reset on restart — these are
 *  operational signals for the demo, not durable analytics. */
export const counters = {
  cacheHits: 0,
  cacheMisses: 0,
};

export function recordHit(): void {
  counters.cacheHits++;
}

export function recordMiss(): void {
  counters.cacheMisses++;
}
