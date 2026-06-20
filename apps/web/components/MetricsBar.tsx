"use client";

import { useState } from "react";
import { fetchMetrics, type Metrics } from "@/lib/api";
import { usePoll } from "@/lib/hooks";

function compact(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

export function MetricsBar({ refreshKey }: { refreshKey: number }) {
  const [m, setM] = useState<Metrics | null>(null);

  usePoll(
    () => {
      void fetchMetrics().then(setM);
    },
    2500,
    refreshKey,
  );

  const stats: Array<{ label: string; value: string }> = [
    { label: "cache hit rate", value: m ? `${Math.round(m.cacheHitRate * 100)}%` : "—" },
    { label: "p95 latency", value: m ? `${m.suggestLatencyMs.p95}ms` : "—" },
    {
      label: "write reduction",
      value: m && m.writeReductionFactor ? `${m.writeReductionFactor.toFixed(1)}×` : "—",
    },
    { label: "indexed queries", value: m ? compact(m.trieSize) : "—" },
  ];

  return (
    <div className="metrics">
      {stats.map((s) => (
        <div className="stat" key={s.label}>
          <span className="stat-value">{s.value}</span>
          <span className="stat-label">{s.label}</span>
        </div>
      ))}
    </div>
  );
}
