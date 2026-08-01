// enable.mjs — greenfield forest-mode activation (spec 'Storage modes',
// ticket T-01KYZ0C7BB3BD36J0MKAA110PV).
//
// Single-file and segmented (forest) are both PERMANENT supported modes; the
// only mode signal is the activation marker the dispatch sites already read
// (lineage.mjs isSegmentedRepo — marker OR cutover-tailed root). This module
// is the missing switch INTO forest mode for a repo with no evidence history.
// The history-preserving cutover for a live root is deliberately not here —
// that is T-MANIFEST-FOREST-MIGRATE's ceremony.
//
// Purely additive by construction: imports the mode predicate and marker path
// from lineage.mjs, changes no dispatch site (those files are this ticket's
// frozen rails).

import { existsSync, mkdirSync, readdirSync, writeFileSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { ADLC_DIR } from '@adlc/core';
import { isSegmentedRepo, markerPath } from './lineage.mjs';
import { segmentDirPath, readRawLines } from './forest.mjs';

// Duplicated from lineage.mjs's module-local constants (that file is a frozen
// rail on this ticket, so no new export could be added there). Skew cannot
// ship silently: enable() self-verifies after writing by asking the IMPORTED
// isSegmentedRepo whether it recognizes the marker, and rolls back if not.
const MARKER = Object.freeze({ format: 'adlc-manifest-segments', version: 1 });

// The minimal .gitignore addition a repo needs so the marker (and segments)
// actually commit. One line is sufficient: a gitignore `*` does not cross
// `/`, so `.adlc/*` only matches the directory itself — re-including the
// directory frees everything inside it. (This repository's own .gitignore
// also carries `!.adlc/manifest.d/**` as belt-and-suspenders; the advice
// here is the sufficient set, verified end-to-end by the apply-the-advice
// test.)
export const MARKER_NEGATION_LINES = Object.freeze(['!.adlc/manifest.d/']);

/**
 * True when git would ignore the segment directory — which would make enable
 * a per-checkout illusion: the marker never commits, every OTHER clone keeps
 * running single-file mode, and evidence diverges by machine. Probed with a
 * TRAILING-SLASH directory path because the directory does not exist yet on
 * a dry-run, and a bare-path probe on a missing directory misreports.
 * Soft-passes (returns false) outside a git repository: evidence without git
 * is supported, and there is nothing to commit or ignore there.
 */
function markerWouldBeIgnored(dir, cwd) {
  const probe = `${relative(cwd, segmentDirPath(dir)).split(sep).join('/')}/`;
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', '--', probe], { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    ignored = true; // check-ignore succeeded: a pattern matches — the marker would never commit
  } catch (err) {
    // no match, or no git repo/binary — nothing blocks committing
  }
  return ignored;
}

/**
 * Decide what `enable` would do, writing nothing. Decision order is
 * load-bearing (ticket work item 1h):
 *   1. no workspace        → refuse (never create .adlc as a side effect)
 *   2. already segmented   → done (marker OR cutover-tailed root — a repo
 *                            that cut over but lost its marker must hear
 *                            "already enabled", not "run the ceremony again")
 *   3. manifest.d has content but no valid marker → refuse (broken state to
 *                            surface, not silently repair)
 *   4. live root           → refuse (history needs the cutover ceremony)
 *   5. gitignored marker   → refuse (see markerWouldBeIgnored)
 *   6. greenfield          → plan the marker write
 *
 * @returns {{ decision: 'refuse-no-workspace'|'already-enabled'|'refuse-broken-manifest-dir'|'refuse-live-root'|'refuse-ignored'|'greenfield', reason?: string, markerPath?: string, marker?: object }}
 */
export function planEnable(dir = ADLC_DIR, { cwd = process.cwd() } = {}) {
  if (!existsSync(dir)) {
    return {
      decision: 'refuse-no-workspace',
      reason: `no ADLC workspace at ${dir} — run adlc-init first; enable never creates one as a side effect`,
    };
  }
  if (isSegmentedRepo(dir)) {
    return { decision: 'already-enabled', reason: 'forest mode is already active for this repository' };
  }
  const segDir = segmentDirPath(dir);
  if (existsSync(segDir) && readdirSync(segDir).length > 0) {
    return {
      decision: 'refuse-broken-manifest-dir',
      reason: `${segDir} has content but no valid activation marker — a broken or half-migrated state to repair by hand, not something enable can adopt`,
    };
  }
  const rootLines = readRawLines(join(dir, 'manifest.jsonl'));
  if (rootLines.length > 0) {
    return {
      decision: 'refuse-live-root',
      reason: 'this repository already records evidence in a single-file root manifest; switching it to forest mode is the history-preserving cutover ceremony (T-MANIFEST-FOREST-MIGRATE), not greenfield enable',
    };
  }
  if (markerWouldBeIgnored(dir, cwd)) {
    return {
      decision: 'refuse-ignored',
      reason: `.gitignore would ignore the activation marker, so every other checkout would silently stay in single-file mode; add first: ${MARKER_NEGATION_LINES.join(' and ')}`,
    };
  }
  return { decision: 'greenfield', markerPath: markerPath(dir), marker: { ...MARKER } };
}

/**
 * Execute the plan. Dry-run (write: false) returns the plan untouched with
 * `written: false`; only a greenfield decision with write: true touches disk.
 * The marker lands atomically (temp file + rename) and is then re-read
 * through the imported isSegmentedRepo — if the resolver does not recognize
 * what we just wrote (format/version skew), the write is rolled back and an
 * operational error thrown rather than leaving a half-active repository.
 *
 * @returns {ReturnType<typeof planEnable> & { written: boolean }}
 */
export function enable(dir = ADLC_DIR, { cwd = process.cwd(), write = false } = {}) {
  const plan = planEnable(dir, { cwd });
  if (plan.decision !== 'greenfield' || !write) return { ...plan, written: false };

  const segDir = segmentDirPath(dir);
  const createdDir = !existsSync(segDir);
  mkdirSync(segDir, { recursive: true });
  const tmp = join(segDir, `.store.json.tmp-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify(plan.marker));
  renameSync(tmp, plan.markerPath);

  if (!isSegmentedRepo(dir)) {
    try { unlinkSync(plan.markerPath); } catch { /* rollback is best-effort */ }
    if (createdDir) { try { rmdirSync(segDir); } catch { /* ditto */ } }
    throw new Error('wrote an activation marker the mode resolver does not recognize — rolled back; enable.mjs and lineage.mjs disagree on the marker format');
  }
  return { ...plan, written: true };
}
