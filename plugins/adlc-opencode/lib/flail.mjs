// flail.mjs — churn/flail detection for OpenCode (Phase 3.3, advisory).
//
// The CC flail-detector reads a transcript; OpenCode has none, so we synthesize
// the same "Editing <path>" log lines the detector already understands from
// tool.execute.after events and feed them to the CANONICAL
// @adlc/flail-detector detectEditChurn (reuse, not re-implement — churn
// threshold and path-extraction stay in one place). Advisory only: it toasts a
// warning once per churning file, never blocks.

// No barrel export on @adlc/flail-detector — import the lib module directly
// (same pattern as @adlc/build-gate/lib/*).
import { detectEditChurn } from '@adlc/flail-detector/lib/signals.mjs';
import { MUTATING_TOOLS } from '../rails-checker.mjs';

// A bounded per-session window so an arbitrarily long session stays cheap.
export const DEFAULT_WINDOW = 200;
// Cap the number of concurrently-tracked sessions and the warned-set size per
// session so a long-lived server process running many sessions / touching many
// generated paths cannot grow this advisory state without bound. When the cap is
// exceeded the least-recently-touched session is evicted (its window is already
// tail-bounded; the warned set is what we're guarding). session.idle also evicts
// explicitly via evict().
export const DEFAULT_MAX_SESSIONS = 64;
export const DEFAULT_MAX_WARNED = 256;

// Same structured-mutator set the rail guard uses, so churn is counted for
// every tool that can rewrite a file (edit/write/patch/multiedit/apply_patch) —
// no divergent allowlist that would silently miss a mutator.
const MUTATOR_TOOLS = new Set(MUTATING_TOOLS);

/**
 * Per-session churn tracker. Records a synthesized log line per structured
 * mutation and reports any file that has newly crossed the churn threshold
 * (detectEditChurn's built-in >= 3), warning at most once per file.
 */
export function createFlailTracker({
  window = DEFAULT_WINDOW,
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxWarned = DEFAULT_MAX_WARNED,
} = {}) {
  const lines = new Map();  // sessionID -> string[]  (insertion order = LRU-ish)
  const warned = new Map(); // sessionID -> Set<path>

  const touch = (sessionID) => {
    // Re-insert to mark most-recently-used, then evict oldest over the cap.
    const buf = lines.get(sessionID);
    lines.delete(sessionID);
    lines.set(sessionID, buf);
    while (lines.size > maxSessions) {
      const oldest = lines.keys().next().value;
      lines.delete(oldest);
      warned.delete(oldest);
    }
  };

  return {
    /**
     * Feed one tool.execute.after event. Returns { churning: [{path,count}] }
     * for files that JUST crossed the threshold (not already warned), else [].
     */
    record({ sessionID, tool, filePath }) {
      const name = String(tool ?? '').toLowerCase();
      if (!sessionID || !MUTATOR_TOOLS.has(name) || !filePath) return { churning: [] };
      const buf = lines.get(sessionID) ?? [];
      buf.push(`Editing ${filePath}`);
      if (buf.length > window) buf.splice(0, buf.length - window); // keep the tail
      lines.set(sessionID, buf);

      const seen = warned.get(sessionID) ?? new Set();
      const churning = detectEditChurn(buf).filter((c) => !seen.has(c.path));
      for (const c of churning) seen.add(c.path);
      // Bound the warned set: if it somehow exceeds the cap, the file window has
      // already rotated past those paths, so dropping the oldest is safe.
      if (seen.size > maxWarned) {
        const drop = seen.size - maxWarned;
        let i = 0;
        for (const p of seen) { if (i++ >= drop) break; seen.delete(p); }
      }
      warned.set(sessionID, seen);
      touch(sessionID);
      return { churning };
    },

    /** Drop a finished session's state (call on session.idle). */
    evict(sessionID) {
      lines.delete(sessionID);
      warned.delete(sessionID);
    },

    /** Test/inspection helper. */
    size() { return lines.size; },
  };
}

/** The advisory message for a churning file. */
export function flailMessage({ path, count }) {
  return `ADLC flail check: ${path} has been edited ${count}× this session — repeated rewrites of one file often signal the model is stuck. Consider stepping back, or resuming in a fresh session before context degrades further.`;
}
