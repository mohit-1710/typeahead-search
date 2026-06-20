"use client";

import { cn } from "@/lib/cn";
import type { Mode } from "@/lib/api";

const OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: "count", label: "Popularity" },
  { value: "recency", label: "Trending" },
];

export function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="mode-toggle" role="tablist" aria-label="ranking mode">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={mode === opt.value}
          className={cn("mode-opt", mode === opt.value && "on")}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
