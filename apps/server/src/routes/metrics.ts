/**
 * GET /metrics — hit rate, DB write counts + reduction factor, and p50/p95/p99
 * suggestion latency. The numbers the performance write-up is built from.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import type { AppContext } from "../context";
import { snapshot } from "../lib/metrics";
import type { WriteBuffer } from "../lib/writeBuffer";

export function registerMetrics(app: FastifyInstance, ctx: AppContext, buffer: WriteBuffer): void {
  app.get("/metrics", async () =>
    snapshot({
      trieSize: ctx.trie.size(),
      walPending: await buffer.pending(),
      cacheNodes: config.cacheNodes.length,
    }),
  );
}
