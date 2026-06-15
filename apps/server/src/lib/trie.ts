/**
 * Completion trie with per-node cached top-K pools.
 *
 * Each node holds the top `POOL` completions found anywhere in its subtree,
 * sorted by all-time count. So answering a prefix is just: walk the prefix
 * (O(prefix length)) and read the node's pool — there is no subtree DFS on the
 * read path. That is the whole point: keystrokes are reads, reads must be cheap.
 *
 * Maintaining those pools is affordable because search counts only ever go *up*.
 * When a query's count rises we walk its own prefix path and bubble it into each
 * ancestor's pool; a query already on top can only stay or climb. The pool keeps
 * a few more than we serve (POOL >= TOP_K) so a later re-rank has spare
 * candidates without re-walking the tree.
 *
 * Trade-off: a pool on every node costs memory (POOL * node count). At ~100-200k
 * queries that is comfortably in RAM; past ~1M you would cap pools by depth and
 * fall back to a bounded walk for deep prefixes. See docs/DESIGN.md.
 */
import type { Mode, QueryStat, Suggestion } from "../types";
import { decay, scoreFor } from "./ranking";

const POOL = 25; // completions cached per node; must be >= the K we serve
const MAX_QUERY_LEN = 120; // bound trie depth against pathological input

interface TrieNode {
  children: Map<string, TrieNode>;
  top: string[]; // query strings, sorted by count desc, length <= POOL
}

function newNode(): TrieNode {
  return { children: new Map(), top: [] };
}

export interface BuildRow {
  query: string;
  count: number;
  recent?: number;
  ts?: number;
}

export class CompletionTrie {
  private root: TrieNode = newNode();
  // query -> live stats. The single source of truth for ranking; nodes only
  // store query strings, never their own copy of the count.
  private stats = new Map<string, QueryStat>();

  size(): number {
    return this.stats.size;
  }

  getStat(query: string): QueryStat | undefined {
    return this.stats.get(query);
  }

  /** Bulk build from the store. Replaces all current state. */
  build(rows: BuildRow[]): void {
    this.root = newNode();
    this.stats = new Map();
    const now = Date.now();
    for (const row of rows) {
      const q = row.query.slice(0, MAX_QUERY_LEN);
      if (!q) continue;
      this.stats.set(q, { count: row.count, recent: row.recent ?? 0, ts: row.ts ?? now });
    }
    for (const q of this.stats.keys()) this.bubble(q);
  }

  /**
   * Apply one flush window of aggregated increments. Counts are exact-additive;
   * each increment also nudges the recency score (decayed to now first). Brand
   * new queries are inserted into the structure on the fly.
   */
  applyIncrements(window: Map<string, number>, now: number = Date.now()): void {
    for (const [raw, inc] of window) {
      const q = raw.slice(0, MAX_QUERY_LEN);
      if (!q || inc <= 0) continue;
      let s = this.stats.get(q);
      if (!s) {
        s = { count: 0, recent: 0, ts: now };
        this.stats.set(q, s);
      }
      s.count += inc;
      s.recent = decay(s.recent, (now - s.ts) / 1000) + inc;
      s.ts = now;
      this.bubble(q);
    }
  }

  /** Top-K completions for a prefix. `count` = all-time popularity; `recency`
   *  re-ranks the cached pool by the popularity/recency blend. */
  getSuggestions(prefix: string, k: number, mode: Mode = "count"): Suggestion[] {
    const p = prefix.slice(0, MAX_QUERY_LEN);
    if (!p) return [];
    const node = this.navigate(p);
    if (!node) return [];

    if (mode === "count") {
      // pool is already sorted by count desc — just take K
      const out: Suggestion[] = [];
      for (const q of node.top) {
        const s = this.stats.get(q);
        if (s) out.push({ query: q, count: s.count });
        if (out.length >= k) break;
      }
      return out;
    }

    // recency: re-rank the cached pool by the hybrid score, then take K. The pool
    // is a popularity-ordered superset, so this only re-orders a handful of rows.
    const now = Date.now();
    return node.top
      .map((q) => {
        const s = this.stats.get(q)!;
        return { query: q, count: s.count, score: scoreFor(mode, s.count, decay(s.recent, (now - s.ts) / 1000)) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ query, count }) => ({ query, count }));
  }

  // ---- internals ----

  private navigate(prefix: string): TrieNode | undefined {
    let node: TrieNode | undefined = this.root;
    for (const ch of prefix) {
      node = node.children.get(ch);
      if (!node) return undefined;
    }
    return node;
  }

  /** Nodes along a query's path, creating any that are missing. */
  private pathNodes(q: string): TrieNode[] {
    const nodes: TrieNode[] = [];
    let node = this.root;
    for (const ch of q) {
      let next = node.children.get(ch);
      if (!next) {
        next = newNode();
        node.children.set(ch, next);
      }
      node = next;
      nodes.push(node);
    }
    return nodes;
  }

  /** Push a query into the pool of each of its prefixes. */
  private bubble(q: string): void {
    for (const node of this.pathNodes(q)) this.poolInsert(node, q);
  }

  /** Insert/refresh `q` in a node's pool, keeping it sorted by count desc and
   *  capped at POOL. Cheap because counts are monotonic. */
  private poolInsert(node: TrieNode, q: string): void {
    const top = node.top;
    const c = this.stats.get(q)!.count;

    const at = top.indexOf(q);
    if (at !== -1) {
      top.splice(at, 1); // present already; remove so we can re-place by new count
    } else if (top.length >= POOL) {
      const weakest = this.stats.get(top[top.length - 1]!)!.count;
      if (c <= weakest) return; // doesn't make the cut
      top.pop();
    }

    let i = top.length;
    while (i > 0 && this.stats.get(top[i - 1]!)!.count < c) i--;
    top.splice(i, 0, q);
  }
}
