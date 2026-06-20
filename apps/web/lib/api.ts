const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";

export type Mode = "count" | "recency";

export interface Suggestion {
  query: string;
  count: number;
}

export interface SuggestResponse {
  prefix: string;
  mode: Mode;
  source: "cache" | "trie" | "empty";
  node?: string;
  suggestions: Suggestion[];
  tookMs?: number;
}

export interface TrendingEntry {
  query: string;
  score: number;
}

export interface Metrics {
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  dbReads: number;
  dbWrites: number;
  dbWriteBatches: number;
  searchesReceived: number;
  writeReductionFactor: number | null;
  suggestLatencyMs: { samples: number; p50: number; p95: number; p99: number };
  trieSize: number;
  walPending: number;
  cacheNodes: number;
}

export async function fetchSuggest(q: string, mode: Mode, signal?: AbortSignal): Promise<SuggestResponse> {
  const res = await fetch(`${BASE}/suggest?q=${encodeURIComponent(q)}&mode=${mode}`, { signal });
  if (!res.ok) throw new Error(`suggest failed (${res.status})`);
  return res.json();
}

export async function postSearch(query: string): Promise<void> {
  await fetch(`${BASE}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

export async function fetchTrending(n = 8): Promise<TrendingEntry[]> {
  try {
    const res = await fetch(`${BASE}/trending?n=${n}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { trending?: TrendingEntry[] };
    return data.trending ?? [];
  } catch {
    return [];
  }
}

export async function fetchMetrics(): Promise<Metrics | null> {
  try {
    const res = await fetch(`${BASE}/metrics`);
    return res.ok ? ((await res.json()) as Metrics) : null;
  } catch {
    return null;
  }
}
