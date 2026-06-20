"use client";

import { motion } from "motion/react";
import { SearchPanel } from "@/components/SearchPanel";

const fade = (delay: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const, delay },
});

export default function Page() {
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
          <SearchPanel />
        </motion.div>
      </div>
    </main>
  );
}
