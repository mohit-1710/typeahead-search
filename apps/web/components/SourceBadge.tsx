"use client";

import { cn } from "@/lib/cn";
import type { SuggestResponse } from "@/lib/api";

function nodeLabel(node?: string): string {
  if (!node) return "";
  const port = node.split(":")[1];
  return port ? `node ${port}` : node;
}

export function SourceBadge({ resp }: { resp: SuggestResponse }) {
  const hit = resp.source === "cache";
  return (
    <span className={cn("source-badge", hit && "hit")} title={resp.node}>
      <span className="dot" />
      {hit ? "cache hit" : "cache miss → trie"}
      {resp.node ? ` · ${nodeLabel(resp.node)}` : ""}
      {typeof resp.tookMs === "number" ? ` · ${resp.tookMs.toFixed(2)}ms` : ""}
    </span>
  );
}
