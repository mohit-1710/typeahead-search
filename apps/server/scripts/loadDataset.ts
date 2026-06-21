/**
 * Dataset ingestion -> Postgres.
 *
 *   pnpm load                      # ~150k synthetic Zipf queries, no download
 *   pnpm load --synthetic 200000   # more
 *   pnpm load --file log.csv       # aggregate a real query log into counts
 *   pnpm load --file log.csv --top 1000000 --min-count 2
 *
 * We want a large dataset, at least 100k queries with counts. Real search traffic is Zipf
 * (a few queries dominate), which is exactly what makes the cache hit rate high,
 * so the synthetic generator reproduces that distribution rather than a flat one.
 * --file aggregates a real log by COUNT(*) per normalized query, the same
 * "derive the counts yourself" path.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { murmur3 } from "../src/lib/hashRing";
import { Store } from "../src/lib/store";

const MAX_LEN = 120;

function normalize(s: string): string {
  return s
    .replace(/\\/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, MAX_LEN);
}

// ---- synthetic generator (Zipf counts) ----

const PREFIXES = [
  "", "how to", "what is", "why is", "best", "buy", "cheap", "learn", "fix",
  "compare", "where to", "is",
];
const TOPICS = [
  "iphone", "android", "macbook", "laptop", "headphones", "coffee", "espresso",
  "react", "typescript", "rust", "python", "kubernetes", "docker", "postgres",
  "redis", "guitar", "piano", "running shoes", "marathon", "yoga", "protein",
  "keto diet", "sourdough", "ramen", "sushi", "pizza", "tacos", "tesla",
  "electric car", "solar panels", "mortgage rates", "index funds", "bitcoin",
  "ethereum", "stock market", "world cup", "formula 1", "nba finals", "premier league",
  "taylor swift", "the weeknd", "stranger things", "dune", "oppenheimer",
  "new york", "tokyo", "lisbon", "iceland", "bali", "patagonia", "swiss alps",
  "standing desk", "mechanical keyboard", "noise cancelling", "air fryer",
  "robot vacuum", "electric scooter", "drone", "gaming pc", "graphics card",
  "smart watch", "fitness tracker", "wireless earbuds", "4k monitor", "vpn",
  "password manager", "cloud storage", "web hosting", "domain name", "logo design",
  "resume template", "cover letter", "interview questions", "salary negotiation",
  "remote jobs", "freelance", "side hustle", "passive income", "credit score",
  "travel insurance", "cheap flights", "road trip", "national parks", "hiking trails",
  "camping gear", "kayak", "surfboard", "snowboard", "rock climbing", "scuba diving",
  "houseplants", "succulents", "vegetable garden", "compost", "lawn care",
  "meal prep", "smoothie", "cold brew", "matcha", "kombucha", "olive oil",
  "skincare routine", "sunscreen", "retinol", "moisturizer", "shampoo",
  "running watch", "trail shoes", "foam roller", "kettlebell", "resistance bands",
];
const QUALIFIERS = [
  "", "review", "vs", "price", "near me", "online", "for beginners", "2026",
  "reddit", "alternative", "deals", "guide", "tips", "explained", "tutorial",
  "comparison",
];
const TAILS = ["", "free", "uk", "cheap", "pro", "deal", "today", "fast"];

/**
 * A query's popularity. Heavy-tailed (Zipf-like) so a few queries dominate —
 * that skew is what gives the cache a high hit rate. Derived from a hash so it's
 * deterministic and spread across the range (no ties from generation order), and
 * biased toward fewer-word queries since head terms are the short, common ones.
 */
function popularity(query: string): number {
  const words = query.split(" ").length;
  const h = murmur3(query) / 0xffffffff; // deterministic 0..1
  const tail = Math.pow(1 - h, 6); // most queries small, a few very large
  const simplicity = 1 / Math.pow(words, 1.8); // short head queries rank higher
  return Math.max(1, Math.floor(6_000_000 * tail * simplicity));
}

function synthetic(n: number): Array<[string, number]> {
  const out = new Map<string, number>();
  for (const p of PREFIXES) {
    for (const t of TOPICS) {
      for (const qf of QUALIFIERS) {
        for (const tl of TAILS) {
          const q = normalize([p, t, qf, tl].filter(Boolean).join(" "));
          if (q && !out.has(q)) {
            out.set(q, popularity(q));
            if (out.size >= n) return [...out];
          }
        }
      }
    }
  }
  // vocabulary exhausted before N — pad with numbered variants
  let i = 0;
  while (out.size < n) {
    const t = TOPICS[i % TOPICS.length]!;
    const q = normalize(`${t} ${Math.floor(i / TOPICS.length)}`);
    if (!out.has(q)) out.set(q, popularity(q));
    i++;
  }
  return [...out];
}

// ---- real log aggregation ----

async function aggregateFile(path: string, minCount: number): Promise<Array<[string, number]>> {
  const counts = new Map<string, number>();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header: string[] | null = null;
  let col = 0;
  let delim = ",";
  for await (const line of rl) {
    if (header === null) {
      delim = line.split("\t").length > line.split(",").length ? "\t" : ",";
      header = line.split(delim).map((h) => h.trim().toLowerCase());
      const qi = header.indexOf("query");
      col = qi >= 0 ? qi : header.length > 1 ? 1 : 0; // many logs are id,query,...
      continue;
    }
    const raw = line.split(delim)[col];
    const q = raw ? normalize(raw) : "";
    if (q && q !== "-") counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  return [...counts].filter(([, c]) => c >= minCount);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      synthetic: { type: "string" },
      file: { type: "string" },
      "min-count": { type: "string", default: "1" },
      top: { type: "string" },
      "no-truncate": { type: "boolean", default: false },
    },
  });

  console.log("aggregating...");
  let rows = values.file
    ? await aggregateFile(values.file, Number(values["min-count"]))
    : synthetic(Number(values.synthetic ?? "150000"));

  if (values.top) {
    rows.sort((a, b) => b[1] - a[1]);
    rows = rows.slice(0, Number(values.top));
  }

  console.log(`${rows.length.toLocaleString()} distinct queries to load`);
  if (rows.length < 100_000) {
    console.warn(`WARNING: ${rows.length.toLocaleString()} queries (< 100k, the minimum we aim for)`);
  }

  const store = new Store();
  try {
    await store.initSchema();
    if (!values["no-truncate"]) await store.truncate();
    await store.bulkLoad(rows);
    console.log(`done. rows in db: ${(await store.countRows()).toLocaleString()}`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
