/**
 * PostgreSQL — the durable source of truth for counts.
 *
 * The trie and the cache are both rebuildable from this table, so Postgres only
 * has to be correct, not fast on the read path (it never serves a keystroke).
 * Writes are additive UPSERTs (`count = count + EXCLUDED.count`) so two flushes
 * that race add instead of clobbering. recent_score is decayed in SQL at flush
 * time, so recency survives a restart and the trie can be rebuilt from it.
 */
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { config } from "../config";
import { counters } from "./metrics";
import type { BuildRow } from "./trie";

const LAMBDA = Math.LN2 / config.ranking.halfLifeSec;
const UPSERT_CHUNK = 1000; // rows per INSERT, keeps us well under the param limit

export class Store {
  private pool: pg.Pool;

  constructor() {
    this.pool = new pg.Pool({
      host: config.pg.host,
      port: config.pg.port,
      user: config.pg.user,
      password: config.pg.password,
      database: config.pg.database,
      max: 10,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS queries (
        query         TEXT PRIMARY KEY,
        count         BIGINT NOT NULL DEFAULT 0,
        recent_score  DOUBLE PRECISION NOT NULL DEFAULT 0,
        last_searched TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // text_pattern_ops lets a LIKE 'prefix%' fallback use this index as a range
    // scan. We serve prefixes from the trie, but it's the right index to have.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_query_prefix ON queries (query text_pattern_ops);`,
    );
  }

  async truncate(): Promise<void> {
    await this.pool.query("TRUNCATE queries;");
  }

  async countRows(): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM queries;");
    return Number(r.rows[0]?.n ?? 0);
  }

  /** Initial dataset load via COPY (streamed, fast). */
  async bulkLoad(rows: Array<[string, number]>): Promise<void> {
    const client = await this.pool.connect();
    try {
      const dbStream = client.query(copyFrom("COPY queries (query, count) FROM STDIN"));
      const source = Readable.from(
        (function* () {
          for (const [q, c] of rows) yield `${copyEscape(q)}\t${c}\n`;
        })(),
      );
      await pipeline(source, dbStream);
    } finally {
      client.release();
    }
  }

  /**
   * Apply one flush window of aggregated increments. Each query contributes its
   * window count to both `count` and `recent_score`; the old recency is decayed
   * to now before the new activity is added. Chunked so a big window stays under
   * Postgres' bind-parameter ceiling. Returns rows written.
   */
  async batchUpsert(window: Map<string, number>): Promise<number> {
    if (window.size === 0) return 0;
    const entries = [...window.entries()];
    for (let i = 0; i < entries.length; i += UPSERT_CHUNK) {
      const chunk = entries.slice(i, i + UPSERT_CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const [q, inc] of chunk) {
        values.push(`($${p++}, $${p++}, $${p++})`);
        params.push(q, inc, inc);
      }
      await this.pool.query(
        `INSERT INTO queries (query, count, recent_score) VALUES ${values.join(",")}
         ON CONFLICT (query) DO UPDATE SET
           count = queries.count + EXCLUDED.count,
           recent_score = queries.recent_score
             * exp(-${LAMBDA} * extract(epoch from (now() - queries.last_searched)))
             + EXCLUDED.recent_score,
           last_searched = now();`,
        params,
      );
      counters.dbWriteBatches += 1;
    }
    counters.dbWrites += entries.length;
    return entries.length;
  }

  /** Every row, for the initial trie build. recency is carried as (score, ts) so
   *  the trie can lazily decay it to read time. */
  async loadAll(): Promise<BuildRow[]> {
    const r = await this.pool.query<{
      query: string;
      count: string;
      recent_score: number;
      last_searched: Date;
    }>("SELECT query, count, recent_score, last_searched FROM queries;");
    return r.rows.map((row) => ({
      query: row.query,
      count: Number(row.count),
      recent: row.recent_score,
      ts: row.last_searched.getTime(),
    }));
  }
}

/** Escape a value for Postgres COPY text format. */
function copyEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}
