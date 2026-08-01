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

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, writeFileSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { ADLC_DIR, withLedgerLock } from '@adlc/core';
import { isSegmentedRepo, markerPath } from './lineage.mjs';
import { segmentDirPath, readRawLines } from './forest.mjs';

// Duplicated from lineage.mjs's module-local constants (that file is a frozen
// rail on this ticket, so no new export could be added there). Skew cannot
// ship silently: enable() self-verifies after writing by asking the IMPORTED
// isSegmentedRepo whether it recognizes the marker, and rolls back if not.
const MARKER = Object.freeze({ format: 'adlc-manifest-segments', version: 1 });

// The .gitignore additions a repo needs so the marker (and segments)
// actually commit. BOTH lines are required for the advice to be sufficient
// across the two common ignore styles (adversarial-review finding, verified
// empirically by the apply-the-advice tests): re-including the directory
// alone frees its contents from a `.adlc/*` rule (a gitignore `*` does not
// cross `/`), but a `.adlc/**` rule matches descendants directly and needs
// the descendant negation too.
export const MARKER_NEGATION_LINES = Object.freeze(['!.adlc/manifest.d/', '!.adlc/manifest.d/**']);

// The probe child needs no secrets and must answer for the repository that
// owns `dir`, not whatever the caller's environment points at: the manifest
// key is scrubbed (repo convention — a child that does not need the key
// never inherits it), and GIT_* repository selectors are dropped so an
// exported GIT_DIR cannot redirect the probe to an unrelated repository.
function gitProbeEnv() {
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/**
 * True when git would ignore the segment directory OR the marker file
 * itself — either makes enable a per-checkout illusion: the marker never
 * commits, every OTHER clone keeps running single-file mode, and evidence
 * diverges by machine. Both paths are probed (adversarial-review finding):
 * a marker-specific rule like `.adlc/manifest.d/.store.json` leaves the
 * directory probe clean while the file can never commit. The directory is
 * probed with a TRAILING SLASH so the answer is right before anything
 * exists on disk (dry-run creates nothing). Runs in the directory that
 * contains `dir`, so `--dir` into another repository is probed against THAT
 * repository. Soft-passes outside any git repository (evidence without git
 * is supported); a real check-ignore failure INSIDE a repository throws
 * rather than guessing — only an exit meaning "no pattern matches" counts
 * as committable.
 */
function markerWouldBeIgnored(dir) {
  const probeCwd = dirname(dir);
  const env = gitProbeEnv();
  const run = (args) => {
    try {
      execFileSync('git', args, { cwd: probeCwd, env, stdio: 'ignore' });
      return 0;
    } catch (err) {
      if (err.code === 'ENOENT') return 'no-git';
      return err.status ?? 'error';
    }
  };
  if (run(['rev-parse', '--is-inside-work-tree']) !== 0) return false; // no git binary, or not a repository
  const rel = relative(probeCwd, segmentDirPath(dir)).split(sep).join('/');
  let ignored = false;
  // Three probes, each catching a rule shape the others miss (adversarial-
  // review findings): the directory (`.adlc/*`-style), the marker file
  // (marker-specific rules), and a representative grammar-valid segment
  // name — a `*.jsonl`-style rule matches neither the directory nor the
  // marker, yet would silently keep every recorded segment local.
  for (const probe of [`${rel}/`, `${rel}/.store.json`, `${rel}/enable-probe-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl`]) {
    const status = run(['check-ignore', '-q', '--', probe]);
    if (status === 0) { ignored = true; break; } // a pattern matches — this path would never commit
    if (status !== 1) {
      throw new Error(`git check-ignore failed while probing ${probe} — cannot verify the marker is committable, refusing to guess`);
    }
  }
  return ignored;
}

// existsSync FOLLOWS symlinks, so a dangling symlink reports "absent" — the
// no-follow refusal below needs its own look at the link itself.
function lstatIsSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
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
export function planEnable(dir = ADLC_DIR) {
  if (!existsSync(dir) && !lstatIsSymlink(dir)) {
    return {
      decision: 'refuse-no-workspace',
      reason: `no ADLC workspace at ${dir} — run adlc-init first; enable never creates one as a side effect`,
    };
  }
  // The workspace itself gets the same no-follow policy as manifest.d below
  // (adversarial-review finding): a symlinked .adlc would route the root
  // lock and the marker outside the selected workspace — refusing only the
  // inner link while following the outer one would be incoherent.
  if (lstatIsSymlink(dir) || !lstatSync(dir).isDirectory()) {
    return {
      decision: 'refuse-no-workspace',
      reason: `${dir} is not a real directory (symlink or other non-directory) — enable refuses to write through links`,
    };
  }
  if (isSegmentedRepo(dir)) {
    return { decision: 'already-enabled', reason: 'forest mode is already active for this repository' };
  }
  const segDir = segmentDirPath(dir);
  // No-follow policy, matching the rest of the store (adversarial-review
  // finding): a symlinked manifest.d would route the marker write outside
  // the workspace, and forest verification rejects a symlinked store anyway
  // — refuse up front instead of succeeding into an unusable state. lstat,
  // never stat: following the link is exactly the bug.
  if (existsSync(segDir) || lstatIsSymlink(segDir)) {
    if (lstatIsSymlink(segDir) || !lstatSync(segDir).isDirectory()) {
      return {
        decision: 'refuse-broken-manifest-dir',
        reason: `${segDir} exists but is not a real directory (symlink or other non-directory) — refusing to write through it`,
      };
    }
    if (readdirSync(segDir).length > 0) {
      return {
        decision: 'refuse-broken-manifest-dir',
        reason: `${segDir} has content but no valid activation marker — a broken or half-migrated state to repair by hand, not something enable can adopt`,
      };
    }
  }
  const rootLines = readRawLines(join(dir, 'manifest.jsonl'));
  if (rootLines.length > 0) {
    return {
      decision: 'refuse-live-root',
      reason: 'this repository already records evidence in a single-file root manifest; switching it to forest mode is the history-preserving cutover ceremony (T-MANIFEST-FOREST-MIGRATE), not greenfield enable',
    };
  }
  if (markerWouldBeIgnored(dir)) {
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
export function enable(dir = ADLC_DIR, { write = false } = {}) {
  const plan = planEnable(dir);
  if (plan.decision !== 'greenfield' || !write) return { ...plan, written: false };

  // Serialize the transition with root-ledger appenders (adversarial-review
  // finding): a recorder passes its own segmented-mode check INSIDE the root
  // lock, so an unlocked enable could observe a still-empty root while that
  // recorder is mid-append — ending with a marker AND a non-cutover root,
  // which is exactly the half-migrated state planEnable refuses. The
  // greenfield decision is re-derived under the SAME lock root appends take
  // (appendEntries locks ledgerPath), and the marker published inside it.
  return withLedgerLock(join(dir, 'manifest.jsonl'), () => {
    const locked = planEnable(dir);
    if (locked.decision !== 'greenfield') return { ...locked, written: false };

    const segDir = segmentDirPath(dir);
    const createdDir = !existsSync(segDir);
    mkdirSync(segDir, { recursive: true });
    // Durable, failure-clean publication (adversarial-review finding),
    // mirroring appendEntries: fsync the marker bytes before the rename and
    // the directory after it, and never strand the temp file — a leftover
    // .store.json.tmp-* would make the NEXT run refuse the directory as a
    // broken half-migrated state, manufacturing exactly what it refuses.
    const tmp = join(segDir, `.store.json.tmp-${randomBytes(6).toString('hex')}`);
    let published = false;
    try {
      const fd = openSync(tmp, 'wx');
      try {
        writeFileSync(fd, JSON.stringify(locked.marker));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(tmp, locked.markerPath);
      published = true;
      if (process.platform !== 'win32') {
        const dirFd = openSync(segDir, 'r');
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
    } finally {
      if (!published) {
        try { unlinkSync(tmp); } catch { /* best-effort — may never have been created */ }
        if (createdDir) { try { rmdirSync(segDir); } catch { /* only removable when empty — correct */ } }
      }
    }

    if (!isSegmentedRepo(dir)) {
      try { unlinkSync(locked.markerPath); } catch { /* rollback is best-effort */ }
      if (createdDir) { try { rmdirSync(segDir); } catch { /* ditto */ } }
      throw new Error('wrote an activation marker the mode resolver does not recognize — rolled back; enable.mjs and lineage.mjs disagree on the marker format');
    }
    return { ...locked, written: true };
  });
}
