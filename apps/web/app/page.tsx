"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { MetricsBar } from "@/components/MetricsBar";
import { SearchPanel } from "@/components/SearchPanel";
import { TrendingPanel } from "@/components/TrendingPanel";

const fade = (delay: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const, delay },
});

export default function Page() {
  // bumped on every submitted search so the panels refresh immediately
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <main className="page">
      <div className="frame">
        <motion.p className="eyebrow" {...fade(0)}>
          distributed typeahead · consistent-hash cache
        </motion.p>
        <motion.h1 className="display" {...fade(0.06)}>
          Find it before you
          <br />
          finish typing.
        </motion.h1>
        <motion.p className="subtitle" {...fade(0.12)}>
          Prefix suggestions ranked by popularity, served from a three-node Redis cache sitting over
          an in-memory trie. Type to watch cache hits, recency ranking, and batched write-backs
          happen live.
        </motion.p>

        <hr className="rule" />

        <motion.div {...fade(0.18)}>
          <SearchPanel onActivity={() => setRefreshKey((k) => k + 1)} />
        </motion.div>

        <motion.div className="two-col" {...fade(0.24)}>
          <MetricsBar refreshKey={refreshKey} />
          <TrendingPanel refreshKey={refreshKey} />
        </motion.div>

        <footer className="footer">
          <span>trie · consistent-hash cache · write-back batching</span>
          <span>fastify · redis ×3 · postgres</span>
        </footer>
      </div>
    </main>
  );
}
