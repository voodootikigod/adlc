// Fleet-observer state persistence for daemon-restart recovery (t-herdr-9 §6.3).
// The pure adopt/tear-down DECISION lives in fleet-bridge.mjs (planFleetRecovery);
// this module is only the file I/O for it, kept here (not in the bin glue) so the
// bounded-read guards and change-detected write are TESTED, not untested wiring.
// The persisted file is UNTRUSTED (unsandboxed, could be tampered): the read is
// size-bounded and fail-soft, and planFleetRecovery validates every field it uses.
import { statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { observerStateSnapshot } from './fleet-bridge.mjs';

// A restart-recovery record is tiny (a run id, a tab id, a ticket→pane map). Cap
// the read well above that but far below anything that could exhaust memory.
export const OBSERVER_STATE_MAX_BYTES = 1_000_000;

/** The gitignored (`.adlc/*`) path where a repo's observer state is persisted. */
export const observerStatePath = (repoRoot) => join(repoRoot, '.adlc', '.herdr-observer.json');

/**
 * Load a repo's persisted observer state. Returns a plain object, or null when
 * the file is absent, not a regular file, larger than the cap, unparseable, or
 * not a JSON object — every failure degrades to "no recovery", never throws.
 */
export function loadObserverState(repoRoot) {
  try {
    const path = observerStatePath(repoRoot);
    const meta = statSync(path);
    if (!meta.isFile() || meta.size > OBSERVER_STATE_MAX_BYTES) return null;
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Persist a repo's observer state, but SKIP the write when the serialized value
 * is unchanged since the last save (recorded on `st.persistSig`) so a steady-state
 * beat causes no disk churn. The write is ATOMIC — a temp file in the same
 * directory then a rename — so a daemon crash mid-write can never leave the state
 * file truncated/invalid (which would blank recovery and orphan every pane).
 * Fail-soft. Returns the JSON that represents the current state (written or not).
 */
export function saveObserverState(repoRoot, st) {
  const json = JSON.stringify(observerStateSnapshot(st));
  if (st.persistSig === json) return json; // unchanged → no write
  try {
    const path = observerStatePath(repoRoot);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, path); // atomic replace on the same filesystem
    st.persistSig = json;
  } catch {
    // best-effort — recovery just won't have the very latest state
  }
  return json;
}
