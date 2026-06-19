/**
 * Drives the running server and reports the numbers the assignment asks for:
 * read latency (p50/p95/p99), cache hit rate, and write reduction from batching.
 *
 *   pnpm bench                              # 8k reads, 20k writes
 *   pnpm bench --reads 20000 --writes 50000 --concurrency 64
 *
 * Reads are drawn Zipf (a few hot prefixes dominate) so the hit rate reflects
 * real traffic. Writes are drawn Zipf over a query pool, so coalescing has
 * duplicates to collapse. Restart the server first for a clean read.
 */
import { parseArgs } from "node:util";
import { percentile } from "../src/lib/metrics";

const BASE = process.env.BENCH_BASE ?? "http://localhost:8080";

interface MetricsResponse {
  cacheHits: number;
  cacheMisses: number;
  dbReads: number;
  dbWrites: number;
  dbWriteBatches: number;
  suggestLatencyMs: { p50: number; p95: number; p99: number };
}
interface RingResponse {
  sampleSize: number;
  distribution: Record<string, number>;
}

const getMetrics = async (): Promise<MetricsResponse> =>
  (await fetch(`${BASE}/metrics`)).json() as Promise<MetricsResponse>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns a function that samples an index 0..n-1 with Zipf(s) weighting. */
function zipfSampler(n: number, s: number): () => number {
  const cum: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += 1 / Math.pow(i + 1, s);
    cum.push(acc);
  }
  const total = acc;
  return () => {
    const r = Math.random() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cum[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

async function runPool(count: number, concurrency: number, task: () => Promise<void>): Promise<void> {
  let issued = 0;
  const worker = async (): Promise<void> => {
    while (issued < count) {
      issued++;
      await task();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

const HEADS = ["how to", "best", "buy", "cheap", "learn", "what is", "compare", "fix"];
const TOPICS = [
  "iphone", "react", "typescript", "rust", "coffee", "espresso", "marathon",
  "tesla", "bitcoin", "ethereum", "guitar", "piano", "sushi", "ramen", "pizza",
  "tokyo", "iceland", "bali", "standing desk", "mechanical keyboard", "air fryer",
  "drone", "gaming pc", "graphics card", "vpn", "cloud storage", "resume template",
  "remote jobs", "credit score", "cheap flights", "national parks", "houseplants",
  "matcha", "kombucha", "sunscreen", "kettlebell",
];
const PREFIXES = [
  "a", "b", "h", "r", "re", "rea", "react", "how", "how ", "best", "buy", "che",
  "lea", "wha", "com", "fix", "ip", "iph", "tes", "bit", "eth", "gui", "pia",
  "sus", "ram", "piz", "tok", "ice", "bal", "sta", "mec", "air", "dro", "gam",
  "gra", "vpn", "clo", "res", "rem", "cre", "nat", "hou", "mat", "kom", "sun", "ket",
];

function buildQueryPool(): string[] {
  const pool: string[] = [];
  for (const h of HEADS) for (const t of TOPICS) pool.push(`${h} ${t}`);
  return pool;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      reads: { type: "string", default: "8000" },
      writes: { type: "string", default: "20000" },
      concurrency: { type: "string", default: "32" },
    },
  });
  const reads = Number(values.reads);
  const writes = Number(values.writes);
  const concurrency = Number(values.concurrency);

  console.log(`benchmark -> ${BASE}  (${reads} reads, ${writes} writes, c=${concurrency})\n`);

  const before = await getMetrics();

  // ---- reads ----
  const pickPrefix = zipfSampler(PREFIXES.length, 1.1);
  const latencies: number[] = [];
  const tRead = performance.now();
  await runPool(reads, concurrency, async () => {
    const p = PREFIXES[pickPrefix()]!;
    const t0 = performance.now();
    await fetch(`${BASE}/suggest?q=${encodeURIComponent(p)}&mode=count`);
    latencies.push(performance.now() - t0);
  });
  const readSecs = (performance.now() - tRead) / 1000;

  // ---- writes ----
  const queryPool = buildQueryPool();
  const pickQuery = zipfSampler(queryPool.length, 1.0);
  const tWrite = performance.now();
  await runPool(writes, concurrency, async () => {
    const q = queryPool[pickQuery()]!;
    await fetch(`${BASE}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
  });
  const writeSecs = (performance.now() - tWrite) / 1000;

  await sleep(1800); // let the write buffer drain

  const after = await getMetrics();
  const ring = (await (await fetch(`${BASE}/cache/ring?sample=6000`)).json()) as RingResponse;

  const hits = after.cacheHits - before.cacheHits;
  const misses = after.cacheMisses - before.cacheMisses;
  const hitRate = hits + misses ? hits / (hits + misses) : 0;
  const rowsWritten = after.dbWrites - before.dbWrites;
  const batches = after.dbWriteBatches - before.dbWriteBatches;

  const pct = (p: number) => percentile(latencies, p).toFixed(3);
  const dist = ring.distribution;
  const shares = Object.values(dist);
  const spread = ((Math.max(...shares) - Math.min(...shares)) / (ring.sampleSize / shares.length)) * 100;

  console.log("── reads ──────────────────────────────────");
  console.log(`  ${reads} reads in ${readSecs.toFixed(2)}s  (${Math.round(reads / readSecs)} req/s, client-side)`);
  console.log(`  client latency  p50 ${pct(50)}ms   p95 ${pct(95)}ms   p99 ${pct(99)}ms`);
  console.log(`  server latency  p50 ${after.suggestLatencyMs.p50}ms   p95 ${after.suggestLatencyMs.p95}ms   p99 ${after.suggestLatencyMs.p99}ms`);
  console.log(`  cache hit rate  ${(hitRate * 100).toFixed(1)}%  (${hits} hits / ${misses} misses)`);
  console.log(`  db reads on the suggest path: ${after.dbReads}`);
  console.log("\n── writes ─────────────────────────────────");
  console.log(`  ${writes} searches in ${writeSecs.toFixed(2)}s  (${Math.round(writes / writeSecs)} req/s)`);
  console.log(`  rows written to postgres: ${rowsWritten}   flush batches: ${batches}`);
  console.log(`  write reduction: ${rowsWritten ? (writes / rowsWritten).toFixed(1) : "n/a"}x fewer rows, ${batches ? (writes / batches).toFixed(0) : "n/a"}x fewer transactions`);
  console.log("\n── ring distribution (6000 keys) ──────────");
  for (const [node, n] of Object.entries(dist)) console.log(`  ${node}: ${n}`);
  console.log(`  spread: ${spread.toFixed(1)}% off even\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
