/**
 * One place for every tunable knob. Each value backs a design decision written
 * up in docs/DESIGN.md, so the trade-offs stay tweakable from .env.
 */
import "dotenv/config";

const str = (key: string, def: string): string => process.env[key] ?? def;
const int = (key: string, def: number): number => {
  const v = process.env[key];
  return v === undefined ? def : Number.parseInt(v, 10);
};
const list = (key: string, def: string): string[] =>
  str(key, def)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: int("PORT", 8080),
  host: str("HOST", "0.0.0.0"),

  pg: {
    host: str("PG_HOST", "localhost"),
    port: int("PG_PORT", 5433),
    user: str("PG_USER", "typeahead"),
    password: str("PG_PASSWORD", "typeahead"),
    database: str("PG_DB", "typeahead"),
  },

  // distributed cache — one Redis per "node", routed by the hash ring
  cacheNodes: list("CACHE_NODES", "localhost:7001,localhost:7002,localhost:7003"),
};
