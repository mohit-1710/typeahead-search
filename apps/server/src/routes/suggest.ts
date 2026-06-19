/**
 * GET /suggest?q=<prefix>&mode=count|recency
 *
 * The read path, fired on every keystroke. Cache-aside: ask the routed Redis
 * node first; on a miss compute the top-K from the trie (O(prefix length)) and
 * fill the cache for next time. A miss never touches Postgres — the trie is the
 * fallback, the DB only rebuilds it.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import type { AppContext } from "../context";
import { recordLatency } from "../lib/metrics";
import type { Mode } from "../types";

function asMode(value: unknown): Mode {
  return value === "recency" ? "recency" : "count";
}

export function registerSuggest(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { q?: string; mode?: string } }>("/suggest", async (req) => {
    const started = performance.now();
    const prefix = (req.query.q ?? "").toLowerCase().trim();
    const mode = asMode(req.query.mode);

    if (!prefix) {
      return { prefix, mode, source: "empty", suggestions: [] };
    }

    const cached = await ctx.cache.getSuggestions(prefix, mode);
    let suggestions = cached.suggestions;
    let source: "cache" | "trie";
    let node = cached.node;

    if (cached.hit && suggestions) {
      source = "cache";
    } else {
      suggestions = ctx.trie.getSuggestions(prefix, config.ranking.topK, mode);
      node = await ctx.cache.setSuggestions(prefix, mode, suggestions, config.cache.ttlSuggestSec);
      source = "trie";
    }

    const tookMs = performance.now() - started;
    recordLatency(tookMs);
    return { prefix, mode, source, node, suggestions, tookMs: Number(tookMs.toFixed(3)) };
  });
}
