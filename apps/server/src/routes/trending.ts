/**
 * GET /trending?n=10 — the current decaying leaderboard, straight from Redis.
 */
import type { FastifyInstance } from "fastify";
import type { Trending } from "../lib/trending";

export function registerTrending(app: FastifyInstance, trending: Trending): void {
  app.get<{ Querystring: { n?: string } }>("/trending", async (req) => {
    const n = Math.min(50, Math.max(1, Number(req.query.n ?? 10) || 10));
    return { trending: await trending.top(n) };
  });
}
