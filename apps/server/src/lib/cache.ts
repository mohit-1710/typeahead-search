/**
 * Distributed suggestion cache over N Redis nodes, routed by the hash ring.
 *
 * Pattern is cache-aside (read): on a miss the caller computes from the trie and
 * fills the cache; on a hit we skip the trie entirely. Writes to the underlying
 * counts do NOT touch the cache (write-around) — a short, jittered TTL refreshes
 * entries instead. The cached value is a computed top-10, and most count updates
 * don't change that list, so recomputing on every write would be wasted work.
 *
 * Routing key is the prefix, so `count` and `recency` for the same prefix land
 * on the same node. The ring is also exposed so the write-ahead log and the
 * trending leaderboard can route their single keys the same deterministic way.
 */
import Redis from "ioredis";
import { config } from "../config";
import type { Mode, Suggestion } from "../types";
import { HashRing } from "./hashRing";
import { recordHit, recordMiss } from "./metrics";

export interface CacheLookup {
  hit: boolean;
  node: string;
  suggestions: Suggestion[] | null;
}

export class CacheCluster {
  private clients = new Map<string, Redis>();
  private ring: HashRing;

  constructor() {
    if (config.cacheNodes.length === 0) {
      throw new Error("no cache nodes configured — set CACHE_NODES in .env");
    }
    this.ring = new HashRing(config.cache.vnodes);
    for (const node of config.cacheNodes) {
      const [host = "localhost", portStr = "6379"] = node.split(":");
      this.clients.set(
        node,
        new Redis({ host, port: Number(portStr), lazyConnect: true, maxRetriesPerRequest: 2 }),
      );
      this.ring.addNode(node);
    }
  }

  /** Connect (lazily) and confirm every node answers. Safe to call again on retry. */
  async ready(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.ping()));
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.quit()));
  }

  /** The Redis client that owns an arbitrary routing key (used by WAL + trending). */
  clientFor(routingKey: string): Redis {
    return this.clients.get(this.ring.getNode(routingKey)!)!;
  }

  nodeFor(routingKey: string): string {
    return this.ring.getNode(routingKey)!;
  }

  private suggKey(prefix: string, mode: Mode): string {
    return `sugg:${mode}:${prefix}`;
  }

  /** Jitter the TTL so a burst of fills doesn't all expire on the same tick. */
  private jitterTtl(ttlSec: number): number {
    const delta = ttlSec * config.cache.ttlJitter;
    return Math.max(1, Math.round(ttlSec + (Math.random() * 2 - 1) * delta));
  }

  async getSuggestions(prefix: string, mode: Mode): Promise<CacheLookup> {
    const node = this.nodeFor(prefix);
    const raw = await this.clients.get(node)!.get(this.suggKey(prefix, mode));
    if (raw === null) {
      recordMiss();
      return { hit: false, node, suggestions: null };
    }
    recordHit();
    return { hit: true, node, suggestions: JSON.parse(raw) as Suggestion[] };
  }

  async setSuggestions(prefix: string, mode: Mode, suggestions: Suggestion[], ttlSec: number): Promise<string> {
    const node = this.nodeFor(prefix);
    await this.clients
      .get(node)!
      .set(this.suggKey(prefix, mode), JSON.stringify(suggestions), "EX", this.jitterTtl(ttlSec));
    return node;
  }

  /** Powers GET /cache/debug: routing detail + whether the key is live right now. */
  async debug(prefix: string, mode: Mode) {
    const info = this.ring.debug(prefix);
    const present =
      info.ownerNode !== null &&
      (await this.clients.get(info.ownerNode)!.exists(this.suggKey(prefix, mode))) === 1;
    return {
      ...info,
      mode,
      redisKey: this.suggKey(prefix, mode),
      currentlyCached: present,
      status: present ? "HIT" : "MISS",
    };
  }

  /** Distribution of a sample of keys across nodes — proof the ring is balanced. */
  ringDistribution(sample: number) {
    const keys: string[] = [];
    const letters = "abcdefghijklmnopqrstuvwxyz";
    for (let i = 0; i < sample; i++) {
      const a = letters[i % 26]!;
      const b = letters[Math.floor(i / 26) % 26]!;
      const c = letters[Math.floor(i / 676) % 26]!;
      keys.push(a + b + c);
    }
    return {
      nodes: this.ring.nodeList(),
      vnodesPerNode: config.cache.vnodes,
      sampleSize: sample,
      distribution: this.ring.distribution(keys),
    };
  }
}
