/**
 * Two ways to rank suggestions:
 *   count   — raw all-time popularity. Stable, the sensible default.
 *   recency — blend popularity with a time-decayed recency score so a query
 *             that's spiking right now can out-rank a bigger but stale one.
 *
 * The recency score halves every `halfLifeSec` of silence (exponential decay),
 * so a short burst fades on its own instead of ranking forever. Same aging idea
 * that keeps the trending leaderboard honest.
 */
import { config } from "../config";
import type { Mode } from "../types";

// exp(-LAMBDA * halfLife) = 0.5  ->  LAMBDA = ln(2) / halfLife
const LAMBDA = Math.LN2 / config.ranking.halfLifeSec;

/** Decay a recency score forward by `dtSeconds` of inactivity. */
export function decay(recent: number, dtSeconds: number): number {
  if (dtSeconds <= 0) return recent;
  return recent * Math.exp(-LAMBDA * dtSeconds);
}

/** Popularity (log-scaled for the power law) blended with recency. */
export function hybridScore(count: number, recent: number): number {
  return config.ranking.wPop * Math.log1p(count) + config.ranking.wRec * recent;
}

export function scoreFor(mode: Mode, count: number, recent: number): number {
  return mode === "count" ? count : hybridScore(count, recent);
}
