export type Mode = "count" | "recency";

export interface Suggestion {
  query: string;
  count: number;
}

/** Live per-query state. `recent` is a recency score decayed lazily to `ts`. */
export interface QueryStat {
  count: number;
  recent: number;
  ts: number;
}
