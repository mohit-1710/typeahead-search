"use client";

import { useState } from "react";
import { fetchTrending, type TrendingEntry } from "@/lib/api";
import { usePoll } from "@/lib/hooks";

export function TrendingPanel({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<TrendingEntry[]>([]);

  usePoll(
    () => {
      void fetchTrending(8).then(setItems);
    },
    2500,
    refreshKey,
  );

  const max = items.length ? Math.max(...items.map((i) => i.score)) : 1;

  return (
    <div className="panel">
      <div className="panel-title">
        <span className="live-dot" /> trending now
      </div>

      {items.length === 0 ? (
        <p className="empty-note">No searches yet — submit a query to light up the leaderboard.</p>
      ) : (
        items.map((t, i) => (
          <div className="trend-row" key={t.query}>
            <span className="trend-rank">{String(i + 1).padStart(2, "0")}</span>
            <div className="trend-q">
              <span>{t.query}</span>
              <span className="trend-bar" style={{ width: `${Math.max(6, (t.score / max) * 100)}%` }} />
            </div>
            <span className="trend-score">{t.score.toFixed(1)}</span>
          </div>
        ))
      )}
    </div>
  );
}
