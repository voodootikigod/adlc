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

import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { ADLC_DIR, ledgerPath, withLedgerLock } from '@adlc/core';
import { isSegmentedRepo, markerPath, readBoundedJsonNoFollow } from './lineage.mjs';
import { segmentDirPath } from './forest.mjs';

// Duplicated from lineage.mjs's module-local constants (that file is a frozen
// rail on this ticket, so no new export could be added there). Skew cannot
// ship silently: enable() self-verifies after writing by asking the IMPORTED
// isSegmentedRepo whether it recognizes the marker, and rolls back if not.
const MARKER = Object.freeze({ format: 'adlc-manifest-segments', version: 1 });
const AUTH_MODES = Object.freeze(['keyed', 'keyless']);

// Forest mode is reachable before the CI gate that guards it exists:
// packages/rails-guard/lib/ci/manifest.mjs reads only .adlc/manifest.jsonl, so
// committed segment files get none of the append-only enforcement the root
// gets. That is not a regression — forest mode never had the coverage — but an
// operator who is never shown the tradeoff cannot weigh it, so activation
// discloses it. `code` is the contract that callers and tests key on; `message`
// is human text and free to be reworded. Removed by the forest CI gate
// (T-MANIFEST-FOREST slice 6), which is what closes the gap.
export const CI_COVERAGE_WARNING = Object.freeze({
  code: 'ci-cannot-guard-segments',
  message: 'rails-guard does not yet validate .adlc/manifest.d/ segment files, so rewriting or deleting committed '
    + 'segment evidence in a pull request is not currently detected by CI. The root manifest remains guarded. '
    + 'This closes when the forest CI gate ships.',
});

// The honest answer when a BOUNDED read cannot decide whether a repository is
// in forest mode. Distinct from CI_COVERAGE_WARNING because that code asserts
// a fact — this repository IS segmented — which an undecidable read has not
// established. Collapsing the two would either claim segmentation for an
// ordinary single-file repo with an enormous trailing entry, or say nothing
// at all about a repo that may well be segmented. Neither is true; this is.
export const SEGMENTATION_UNDETERMINED_WARNING = Object.freeze({
  code: 'segmentation-undetermined',
  message: 'could not determine within a bounded read whether this repository uses segmented (forest) evidence '
    + 'storage, because the root manifest\'s final entry could not be read within the probe window. If it IS '
    + 'segmented, note that rails-guard does not yet validate .adlc/manifest.d/ segment files. Run this command '
    + 'with a signing key configured for a definite answer.',
});

// The .gitignore contract forest mode needs is TWO-SIDED (adversarial-review
// findings, verified empirically by the apply-the-advice tests): the marker
// and segments must be COMMITTABLE (both negation lines — re-including the
// directory frees its contents from a `.adlc/*` rule, and the descendant
// negation additionally defeats `.adlc/**`-style rules that match
// descendants directly), while the checkout-local `.lineage` token and lock
// files must stay IGNORED (the re-ignore lines — a TRACKED token recreates
// the tail conflict forest mode removes, and a committed token makes every
// clone treat its segment as self-minted, poisoning the peeked fast path's
// trust assumption). Order matters: gitignore is last-match-wins, so the
// re-ignores must follow the negations.
export const MARKER_NEGATION_LINES = Object.freeze([
  '!.adlc/manifest.d/',
  '!.adlc/manifest.d/**',
  '.adlc/manifest.d/.lineage',
  '.adlc/manifest.d/*.lock',
  '.adlc/manifest.d/*.tmp-*',
]);

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
export function gitignoreContractViolation(dir) {
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
  if (run(['rev-parse', '--is-inside-work-tree']) !== 0) return null; // no git binary, or not a repository
  const rel = relative(probeCwd, segmentDirPath(dir)).split(sep).join('/');
  const probe = (path) => {
    const status = run(['check-ignore', '-q', '--', path]);
    if (status !== 0 && status !== 1) {
      throw new Error(`git check-ignore failed while probing ${path} — cannot verify the gitignore contract, refusing to guess`);
    }
    return status === 0; // a pattern matches — git would ignore this path
  };
  // Committable side — three probes, each catching a rule shape the others
  // miss (adversarial-review findings): the directory (`.adlc/*`-style), the
  // marker file (marker-specific rules), and a representative grammar-valid
  // segment name (`*.jsonl`-style rules match neither of the first two).
  for (const path of [`${rel}/`, `${rel}/.store.json`, `${rel}/enable-probe-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl`]) {
    if (probe(path)) return '.gitignore would ignore the activation marker or its evidence segments, so every other checkout would silently stay in single-file mode';
  }
  // Ignored side (adversarial-review finding): the checkout-local token and
  // lock files must NEVER be trackable — a committed `.lineage` recreates
  // the tail conflict forest mode removes and makes every clone treat its
  // segment as self-minted, poisoning the peeked fast path's trust.
  for (const path of [`${rel}/.lineage`, `${rel}/enable-probe.lock`]) {
    if (!probe(path)) return 'git would TRACK the checkout-local lineage token or lock files, which must stay ignored — a committed token recreates the merge conflict forest mode removes';
  }
  return null;
}

// existsSync FOLLOWS symlinks, so a dangling symlink reports "absent" — the
// no-follow refusal below needs its own look at the link itself.
function lstatIsSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * A BOUNDED, no-follow answer to "is this repository already in forest mode",
 * for callers that must not perform open-ended work — notably the CLI's
 * keyless refusal, which returns before any planning happens.
 *
 * Deliberately narrower than lineage.mjs's isSegmentedRepo. That predicate is
 * marker OR cutover-tailed-root, and the second half reads the ENTIRE root
 * manifest through readRawLines, following symlinks: unbounded work on a path
 * an attacker can point at a huge file or a non-terminating device.
 *
 * The marker read delegates to lineage.mjs's readBoundedJsonNoFollow, which
 * is lstat + O_NOFOLLOW + a single capped read from ONE descriptor. Doing the
 * check with lstat and then reopening via readFileSync would be a TOCTOU
 * window: the path can be replaced between the two calls, so the size that
 * was validated and the bytes that are read need not describe the same
 * inode. The containing directories keep their own no-follow checks.
 *
 * The tradeoff is explicit: a cutover-tailed repo whose marker was lost reads
 * as false. That is the safe direction — it under-reports a disclosure rather
 * than reading an unbounded root — and the cutover ceremony writes the marker,
 * so a missing one is the degraded case and not the norm. Never throws; a
 * caller on a refusal path must not have its exit code changed by this probe.
 */
export function isMarkerActivated(dir = ADLC_DIR) {
  for (const path of [dir, segmentDirPath(dir)]) {
    if (lstatIsSymlink(path)) return false;
  }
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return parsed?.format === MARKER.format && parsed?.version === MARKER.version;
}

// How much of the root's tail a bounded cutover probe may read.
//
// Sized against the real distribution, not a guess: this repository's own
// 99 KB / 176-entry ledger has a longest entry of ~6.7 KB, so an 8 KB window
// left only a 20% margin before a final entry became undecidable. 64 KB gives
// roughly an order of magnitude of headroom while staying a single bounded
// read of fixed memory.
//
// The size matters because undecidable resolves to "warn" (see
// isSegmentedBounded): too small a window turns ordinary ledgers with large
// trailing entries into spurious warnings, and too large stops being a bound.
const TAIL_PROBE_BYTES = 65536;

/**
 * Whether the root manifest's LAST line is the cutover entry, read within a
 * fixed window from one no-follow descriptor.
 *
 * Tri-state: 'yes' | 'no' | 'unknown'. The bound makes some roots
 * undecidable — a final line longer than the window, an unreadable or
 * non-regular file — and collapsing those to 'no' is what makes a bounded
 * probe silently disagree with the production predicate, which has no such
 * limit and will happily route writes to segments.
 *
 * lineage.mjs answers this by passing the ENTIRE file through readRawLines,
 * which is fine for a writer already committed to the ledger but not for the
 * CLI's keyless refusal — that path must not be convertible into an unbounded
 * read. So the file is opened once with O_NOFOLLOW, sized via fstat on THAT
 * descriptor (never a second lstat, whose answer could describe a different
 * inode), and only the final window is read. Never throws.
 */
function rootTailIsCutover(dir) {
  const root = ledgerPath('manifest', dir);
  let stats;
  try {
    stats = lstatSync(root);
  } catch {
    return 'no'; // absent: determinate, this repo has no root at all
  }
  if (!stats.isFile()) return 'unknown'; // symlink/fifo/device — undecidable without following, which we will not do
  let fd;
  try {
    fd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return 'unknown';
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return 'no';
    const window = Math.min(size, TAIL_PROBE_BYTES);
    const buf = Buffer.alloc(window);
    const bytesRead = readSync(fd, buf, 0, window, size - window);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    // A truncated window whose FIRST line is a fragment is fine — only the
    // last line is inspected. But with no boundary anywhere in the window the
    // final line alone exceeds it and cannot be parsed: undecidable.
    if (size > window && !text.includes('\n')) return 'unknown';
    const lines = text.split('\n').filter((line) => line.trim());
    if (lines.length === 0) {
      // Nothing but blank lines in the window. Determinate ONLY if the window
      // was the whole file; otherwise a trailing run of newlines longer than
      // the window hides the real last entry, which the production predicate
      // finds because it filters blanks across the entire file.
      return size > window ? 'unknown' : 'no';
    }
    return JSON.parse(lines.at(-1))?.gate === 'manifest-cutover' ? 'yes' : 'no';
  } catch {
    return 'unknown';
  } finally {
    closeSync(fd);
  }
}

/**
 * Which disclosure a bounded, no-follow look at this repository justifies:
 * 'segmented' | 'single-file' | 'undetermined'.
 *
 * TRI-STATE on purpose. An earlier binary version had to map undecidable
 * roots to one side or the other, and both were false statements: mapping to
 * segmented claims forest mode for an ordinary single-file repo whose final
 * entry exceeds the window, and mapping to single-file stays silent about a
 * repo that may well be segmented. The read is uncertain, so the answer is.
 *
 * Both halves of spec §4.7 are covered — a repository cut over by hand has a
 * cutover tail and NO marker, since `gate-manifest record manifest-cutover`
 * accepts free-form gate names, and a marker-only probe would call it
 * single-file. Never throws: callers sit on a refusal path whose exit code
 * must not change.
 */
export function boundedSegmentationState(dir = ADLC_DIR) {
  if (isMarkerActivated(dir)) return 'segmented';
  switch (rootTailIsCutover(dir)) {
    case 'yes': return 'segmented';
    case 'no': return 'single-file';
    case 'unknown': return 'undetermined';
    // An unrecognized probe result must NOT fall through to 'single-file':
    // that is the one answer which asserts a fact and stays silent, so a
    // future edit returning something unexpected would silently suppress the
    // disclosure. Unrecognized means undetermined, like any other read this
    // function could not decide.
    default: return 'undetermined';
  }
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
 * `warnings` is present only on the two segmented outcomes (greenfield,
 * already-enabled) — see CI_COVERAGE_WARNING.
 *
 * @returns {{ decision: 'refuse-no-workspace'|'already-enabled'|'refuse-broken-manifest-dir'|'refuse-live-root'|'refuse-ignored'|'greenfield', reason?: string, markerPath?: string, marker?: object, warnings?: Array<{code: string, message: string}> }}
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
  // The ROOT's no-follow refusal must also precede the already-enabled
  // probe (adversarial-review finding): isSegmentedRepo's cutover-tail check
  // reads manifest.jsonl in full through readRawLines, which follows
  // symlinks — a root symlinked at an unbounded source (a device file)
  // would be consumed before any later lstat refusal ran. lstat first, read
  // never.
  const rootPath = join(dir, 'manifest.jsonl');
  if (lstatIsSymlink(rootPath)) {
    return {
      decision: 'refuse-broken-manifest-dir',
      reason: `${rootPath} is a symlink — refusing to inspect or activate through it`,
    };
  }
  const segDir = segmentDirPath(dir);
  // No-follow policy, matching the rest of the store, checked BEFORE the
  // already-enabled probe (adversarial-review finding): the bounded marker
  // reader only refuses a symlink at the FINAL path component, so a
  // symlinked manifest.d whose TARGET holds a valid marker would otherwise
  // read as already-enabled — reporting success for a layout forest
  // verification rejects. A symlinked (or dangling-symlinked, or
  // non-directory) manifest.d is a broken state regardless of what its
  // target contains. lstat, never stat: following the link is exactly the
  // bug.
  if ((existsSync(segDir) || lstatIsSymlink(segDir)) && (lstatIsSymlink(segDir) || !lstatSync(segDir).isDirectory())) {
    return {
      decision: 'refuse-broken-manifest-dir',
      reason: `${segDir} exists but is not a real directory (symlink or other non-directory) — refusing to write through it`,
    };
  }
  if (isSegmentedRepo(dir)) {
    // The gitignore contract is checked on the already-enabled path too
    // (adversarial-review finding): ignore rules can drift AFTER activation
    // — or the marker can predate this command — and an idempotent
    // health-check run that reports success while .lineage became trackable
    // (or the marker became local-only) defeats the contract this command
    // exists to enforce.
    const enabledViolation = gitignoreContractViolation(dir);
    if (enabledViolation !== null) {
      // Warned despite being a REFUSAL: this branch is inside isSegmentedRepo,
      // so the repository is in forest mode and exposed right now. Keying
      // disclosure off the decision would let an operator fix the ignore drift
      // and keep writing segments having never been told CI cannot guard them.
      return {
        decision: 'refuse-ignored',
        reason: `forest mode is already active, BUT ${enabledViolation}; restore this block (order matters): ${MARKER_NEGATION_LINES.join(' , ')}`,
        warnings: [CI_COVERAGE_WARNING],
      };
    }
    // Already segmented means segments are being written RIGHT NOW, so this
    // path needs the disclosure every bit as much as a fresh activation.
    return {
      decision: 'already-enabled',
      reason: 'forest mode is already active for this repository',
      warnings: [CI_COVERAGE_WARNING],
    };
  }
  if (existsSync(segDir) && readdirSync(segDir).length > 0) {
    return {
      decision: 'refuse-broken-manifest-dir',
      reason: `${segDir} has content but no valid activation marker — a broken or half-migrated state to repair by hand, not something enable can adopt`,
    };
  }
  // Greenfield only needs the root's EMPTINESS, which lstat answers — no
  // read (the symlink case was already refused above, before any mode
  // predicate could open the file).
  if (existsSync(rootPath) && lstatSync(rootPath).size > 0) {
    return {
      decision: 'refuse-live-root',
      reason: 'this repository already records evidence in a single-file root manifest; switching it to forest mode is the history-preserving cutover ceremony (T-MANIFEST-FOREST-MIGRATE), not greenfield enable',
    };
  }
  const violation = gitignoreContractViolation(dir);
  if (violation !== null) {
    return {
      decision: 'refuse-ignored',
      reason: `${violation}; add this block (order matters): ${MARKER_NEGATION_LINES.join(' , ')}`,
    };
  }
  // Refusals on a NON-segmented repository carry no warning: nothing is
  // writing segments there, and a warning on every outcome is noise that
  // trains operators to skip warnings entirely. The already-segmented
  // refusal above is the deliberate exception.
  return { decision: 'greenfield', markerPath: markerPath(dir), marker: { ...MARKER }, warnings: [CI_COVERAGE_WARNING] };
}

/**
 * The marker persists the forest's AUTHENTICATION MODE (adversarial-review
 * finding): checking the key only at activation verifies the operator's
 * environment in that one moment, while the first mint may happen later in
 * a hook, CI job, or worktree missing the variable — an unsigned first
 * entry in a keyed forest permanently strands every keyed clone (a v2
 * signature can never be added retroactively). The resolvers enforce the
 * recorded mode on every segmented write, so the invariant lives in the
 * repository, not the shell.
 */
function markerWithAuth(auth) {
  if (!AUTH_MODES.includes(auth)) {
    throw new Error(`enable auth mode must be one of ${AUTH_MODES.join('/')}`);
  }
  return { ...MARKER, auth };
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
export function enable(dir = ADLC_DIR, { write = false, auth = 'keyed' } = {}) {
  const planned = planEnable(dir);
  const plan = planned.decision === 'greenfield'
    ? { ...planned, marker: markerWithAuth(auth) }
    : planned;
  if (plan.decision !== 'greenfield' || !write) return { ...plan, written: false };

  // Serialize the transition with root-ledger appenders (adversarial-review
  // finding): a recorder passes its own segmented-mode check INSIDE the root
  // lock, so an unlocked enable could observe a still-empty root while that
  // recorder is mid-append — ending with a marker AND a non-cutover root,
  // which is exactly the half-migrated state planEnable refuses. The
  // greenfield decision is re-derived under the SAME lock root appends take
  // (appendEntries locks ledgerPath), and the marker published inside it.
  return withLedgerLock(join(dir, 'manifest.jsonl'), () => {
    const relocked = planEnable(dir);
    if (relocked.decision !== 'greenfield') return { ...relocked, written: false };
    const locked = { ...relocked, marker: markerWithAuth(auth) };

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
      // Publication is complete only once the rename is durable. If the
      // directory fsync fails, the marker is unlinked again so the CLI's
      // failure report matches the on-disk state — otherwise automation
      // would be told "failed" while the mode switch was already visible.
      // A newly created manifest.d also fsyncs its PARENT, so the directory
      // entry itself survives a crash, not just its contents.
      try {
        if (process.platform !== 'win32') {
          for (const toSync of createdDir ? [segDir, dir] : [segDir]) {
            const dirFd = openSync(toSync, 'r');
            try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
          }
        }
        published = true;
      } catch (fsyncErr) {
        // The failure report must match the on-disk state (adversarial-review
        // finding): claim a rollback only when the unlink actually succeeded.
        let rolledBack = false;
        try { unlinkSync(locked.markerPath); rolledBack = true; } catch { /* reported below, not swallowed */ }
        if (rolledBack && process.platform !== 'win32') {
          try {
            const dirFd = openSync(segDir, 'r');
            try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
          } catch { /* the unlink itself succeeded; durability of the deletion is best-effort */ }
        }
        throw new Error(rolledBack
          ? `marker written but not durably published (${fsyncErr.message}) — rolled the marker back; re-run enable`
          : `marker written but not durably published (${fsyncErr.message}) — AND rollback failed, so forest mode may be active on this checkout; inspect ${locked.markerPath} before retrying`);
      }
    } finally {
      if (!published) {
        try { unlinkSync(tmp); } catch { /* best-effort — may never have been created */ }
        if (createdDir) { try { rmdirSync(segDir); } catch { /* only removable when empty — correct */ } }
      }
    }

    if (!isSegmentedRepo(dir)) {
      let rolledBack = false;
      try { unlinkSync(locked.markerPath); rolledBack = true; } catch { /* reported below, not swallowed */ }
      if (rolledBack && createdDir) { try { rmdirSync(segDir); } catch { /* only removable when empty — correct */ } }
      throw new Error(rolledBack
        ? 'wrote an activation marker the mode resolver does not recognize — rolled back; enable.mjs and lineage.mjs disagree on the marker format'
        : `wrote an activation marker the mode resolver does not recognize — AND rollback failed, so an unrecognized marker remains at ${locked.markerPath}; remove it by hand`);
    }
    return { ...locked, written: true };
  });
}
