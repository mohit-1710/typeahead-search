/**
 * Cache introspection — the endpoints that prove the routing actually works.
 *   GET /cache/debug?prefix=<p>&mode=  which node owns the prefix + live HIT/MISS
 *   GET /cache/ring?sample=N           how N sample keys spread across the nodes
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";

export function registerCache(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { prefix?: string; mode?: string } }>(
    "/cache/debug",
    async (req, reply) => {
      const prefix = (req.query.prefix ?? "").toLowerCase().trim();
      if (!prefix) {
        reply.code(400);
        return { error: "prefix is required" };
      }
      const mode = req.query.mode === "recency" ? "recency" : "count";
      return ctx.cache.debug(prefix, mode);
    },
  );

  app.get<{ Querystring: { sample?: string } }>("/cache/ring", async (req) => {
    const sample = Math.min(20000, Math.max(1, Number(req.query.sample ?? 2000) || 2000));
    return ctx.cache.ringDistribution(sample);
  });
}
