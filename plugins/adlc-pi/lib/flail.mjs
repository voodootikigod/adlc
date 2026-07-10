// flail.mjs — edit-churn advisory for pi (spec Phase 2.2, advisory only).
//
// Churn detection is delegated to the CANONICAL @adlc/flail-detector
// (detectEditChurn's built-in >= 3 threshold and its "Editing <path>" log
// grammar) — this module only synthesizes those lines from pi tool events.
// pi runs one session per process, so a single bounded window suffices (no
// multi-session LRU like the opencode port). Never blocks: the caller turns
// newly-churning files into a notify + steer message, once per file.

import { detectEditChurn } from '@adlc/flail-detector/lib/signals.mjs';

/** Bounded window of synthesized mutation lines. */
export const DEFAULT_WINDOW = 200;

export function createFlailTracker({ window = DEFAULT_WINDOW } = {}) {
  let lines = [];
  const warned = new Set();
  return {
    reset() {
      lines = [];
      warned.clear();
    },
    /**
     * Record one structured mutation and return files that NEWLY crossed the
     * churn threshold (warned at most once per file per session).
     * @returns {{ path:string, count:number }[]}
     */
    recordMutation(path) {
      if (typeof path !== 'string' || path === '') return [];
      lines.push(`Editing ${path}`);
      if (lines.length > window) lines = lines.slice(-window);
      const fresh = detectEditChurn(lines).filter((c) => !warned.has(c.path));
      for (const c of fresh) warned.add(c.path);
      return fresh;
    },
  };
}
