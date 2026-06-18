import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "./config";
import type { AppContext } from "./context";
import { CacheCluster } from "./lib/cache";
import { Store } from "./lib/store";
import { CompletionTrie } from "./lib/trie";
import { WriteBuffer } from "./lib/writeBuffer";
import { registerSearch } from "./routes/search";
import { registerSuggest } from "./routes/suggest";

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  const store = new Store();
  const cache = new CacheCluster();
  const trie = new CompletionTrie();

  await store.initSchema();
  await cache.connect();

  app.log.info("building trie from postgres...");
  trie.build(await store.loadAll());
  app.log.info(`trie ready: ${trie.size()} queries across ${config.cacheNodes.length} cache nodes`);

  const ctx: AppContext = { trie, cache, store };
  const buffer = new WriteBuffer({ cache, store, trie });
  buffer.start();

  app.get("/health", async () => ({ status: "ok", trieSize: trie.size() }));
  registerSuggest(app, ctx);
  registerSearch(app, buffer);

  const shutdown = async (): Promise<void> => {
    app.log.info("shutting down...");
    await app.close();
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
