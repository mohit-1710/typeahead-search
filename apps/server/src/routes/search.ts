/**
 * POST /search  { "query": "..." }
 *
 * Records a submitted search. The body is acknowledged synchronously ("Searched")
 * while the count is buffered and written back asynchronously — the response is
 * an ack, not a promise that Postgres is already updated.
 */
import type { FastifyInstance } from "fastify";
import type { WriteBuffer } from "../lib/writeBuffer";

export function registerSearch(app: FastifyInstance, buffer: WriteBuffer): void {
  app.post<{ Body: { query?: string } }>("/search", async (req, reply) => {
    const query = (req.body?.query ?? "").trim();
    if (!query) {
      reply.code(400);
      return { error: "query is required" };
    }
    await buffer.record(query);
    return { message: "Searched", query };
  });
}
