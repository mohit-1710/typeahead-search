"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { fetchSuggest, postSearch, type Mode, type SuggestResponse } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useDebouncedValue } from "@/lib/hooks";
import { ModeToggle } from "./ModeToggle";
import { SourceBadge } from "./SourceBadge";

/** Split a query so the matched prefix can be highlighted. */
function parts(query: string, prefix: string): [string, string] {
  if (prefix && query.toLowerCase().startsWith(prefix.toLowerCase())) {
    return [query.slice(0, prefix.length), query.slice(prefix.length)];
  }
  return ["", query];
}

export function SearchPanel({ onActivity }: { onActivity?: () => void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("count");
  const [resp, setResp] = useState<SuggestResponse | null>(null);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounced = useDebouncedValue(text, 110);
  const wrapRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // the query we just submitted — keeps a late debounce from re-opening the menu
  const submittedRef = useRef<string | null>(null);

  // debounced suggestion fetch — one in-flight request, older ones aborted
  useEffect(() => {
    const q = debounced.trim();
    if (!q) {
      setResp(null);
      setOpen(false);
      setActive(-1);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetchSuggest(q, mode, ctrl.signal)
      .then((r) => {
        setResp(r);
        setOpen(r.suggestions.length > 0 && submittedRef.current !== q);
        setActive(-1);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, [debounced, mode]);

  // close the dropdown on an outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const suggestions = resp?.suggestions ?? [];

  async function submit(query: string) {
    const q = query.trim();
    if (!q) return;
    submittedRef.current = q;
    setText(q);
    setOpen(false);
    setActive(-1);
    await postSearch(q);
    onActivity?.();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(suggestions.length > 0);
      setActive((a) => Math.min(a + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      submit(active >= 0 && suggestions[active] ? suggestions[active]!.query : text);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <section>
      <div className="search-row">
        <div className="input-wrap" ref={wrapRef}>
          <SearchIcon />
          <input
            value={text}
            onChange={(e) => {
              submittedRef.current = null; // typing again — allow the menu to open
              setText(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setOpen(suggestions.length > 0)}
            placeholder="Search 150k queries…"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="search"
          />
          {text ? <span className="kbd">esc</span> : <span className="kbd">/</span>}

          <AnimatePresence>
            {open && suggestions.length > 0 && (
              <motion.ul
                className="dropdown"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              >
                {suggestions.map((s, i) => {
                  const [head, tail] = parts(s.query, debounced.trim());
                  return (
                    <li
                      key={s.query}
                      className={cn("dropdown-item", i === active && "active")}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        submit(s.query);
                      }}
                    >
                      <span className="di-query">
                        {head && <span className="hl">{head}</span>}
                        {tail}
                      </span>
                      <span className="di-count">{s.count.toLocaleString()}</span>
                    </li>
                  );
                })}
              </motion.ul>
            )}
          </AnimatePresence>
        </div>

        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      <div className="meta-row">
        {resp && resp.source !== "empty" ? (
          <SourceBadge resp={resp} />
        ) : (
          <span className="hint">type to search · ↑↓ to navigate · enter to select</span>
        )}
        {resp && resp.source !== "empty" && (
          <span className="hint">{suggestions.length} suggestions</span>
        )}
      </div>

      {error && <p className="err">backend unreachable — is the server running on :8080? ({error})</p>}
    </section>
  );
}

function SearchIcon() {
  return (
    <svg className="search-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.7" />
      <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
