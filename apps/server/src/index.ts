import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config";
import type { AppContext } from "./context";
import { CacheCluster } from "./lib/cache";
import { Store } from "./lib/store";
import { Trending } from "./lib/trending";
import { CompletionTrie } from "./lib/trie";
import { WriteBuffer } from "./lib/writeBuffer";
import { registerCache } from "./routes/cache";
import { registerMetrics } from "./routes/metrics";
import { registerSearch } from "./routes/search";
import { registerSuggest } from "./routes/suggest";
import { registerTrending } from "./routes/trending";

/** Retry `fn` until it succeeds — so `docker compose up` and `start` can race. */
async function waitFor(
  app: FastifyInstance,
  label: string,
  fn: () => Promise<void>,
  attempts = 30,
  delayMs = 1000,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      app.log.warn(`${label} not ready (attempt ${attempt}/${attempts}) — retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  const store = new Store();
  const cache = new CacheCluster();
  const trie = new CompletionTrie();

  await waitFor(app, "postgres", () => store.initSchema());
  await waitFor(app, "redis", () => cache.ready());

  app.log.info("building trie from postgres...");
  trie.build(await store.loadAll());
  app.log.info(`trie ready: ${trie.size()} queries across ${config.cacheNodes.length} cache nodes`);

  const ctx: AppContext = { trie, cache, store };
  const trending = new Trending(cache);
  const buffer = new WriteBuffer({ cache, store, trie, trending });
  buffer.start();
  trending.startDecay();

  app.get("/health", async () => ({ status: "ok", trieSize: trie.size() }));
  registerSuggest(app, ctx);
  registerSearch(app, buffer);
  registerTrending(app, trending);
  registerMetrics(app, ctx, buffer);
  registerCache(app, ctx);

  const shutdown = async (): Promise<void> => {
    app.log.info("shutting down...");
    await app.close();
    trending.stopDecay();
    await buffer.stop(); // final drain before we let go of redis
    await cache.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
