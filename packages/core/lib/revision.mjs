import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { splitNulPaths } from './git.mjs';
import { existsSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function newHash() {
  const hash = createHash('sha256');
  return {
    add(part) {
      hash.update(part);
      hash.update('\0');
    },
    digest() {
      return hash.digest('hex');
    },
  };
}

function addWorkingTreeFile(hash, cwd, relative, object) {
  const absolute = join(cwd, relative);
  if (!existsSync(absolute)) {
    return;
  }
  hash.add(Buffer.from(relative));
  const stat = statSync(absolute);
  if (!stat.isFile()) {
    hash.add(Buffer.from(`non-file:${stat.mode}:${stat.size}`));
    return;
  }
  const mode = (stat.mode & 0o111) ? '100755' : '100644';
  hash.add(Buffer.from(`git-blob:${mode}:${object}`));
}

// Delegate to the shared buffer-level splitter so a path git cannot decode
// faithfully fails closed here too, instead of aliasing another path (#249). The
// local `git()` above returns a Buffer (no encoding set), which is exactly what
// splitNulPaths needs to split BEFORE decoding.
function splitNull(raw) {
  return splitNulPaths(raw);
}

function trackedEntries(cwd) {
  const entries = new Map();
  for (const record of splitNull(git(['ls-files', '-s', '-z'], cwd))) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const metadata = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    if (metadata.length >= 3 && path) entries.set(path, { mode: metadata[0], object: metadata[1] });
  }
  return entries;
}

function dirtyTrackedPaths(cwd) {
  return new Set(splitNull(git(['diff', '--name-only', '-z'], cwd)));
}

function addGitBlob(hash, relative, entry) {
  hash.add(Buffer.from(relative));
  hash.add(Buffer.from(`git-blob:${entry.mode}:${entry.object}`));
}

function batchWorkingTreeBlobs(cwd, paths) {
  if (paths.length === 0) return new Map();
  const objects = new Map();
  let chunk = [];
  let chunkBytes = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    const output = git(['hash-object', '--', ...chunk], cwd).toString('utf8').split('\n').filter(Boolean);
    for (const [index, path] of chunk.entries()) {
      const object = output[index];
      if (object) objects.set(path, object);
    }
    chunk = [];
    chunkBytes = 0;
  };

  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path) + 1;
    if (chunk.length > 0 && chunkBytes + pathBytes > 128 * 1024) flush();
    chunk.push(path);
    chunkBytes += pathBytes;
  }
  flush();
  return objects;
}

const DEFAULT_IGNORED_PATHS = [
  '.adlc/manifest.jsonl',
  '.adlc/manifest.lock',
  '.adlc/tickets.json',
  '.adlc/tickets',
  '.adlc/ticket-archive',
  '.adlc/current-ticket.json',
];

// Canonicalize a path through symlinks so that different aliases of the same
// location collapse to one form (macOS /var -> /private/var, /tmp -> /private/tmp).
// A not-yet-existent leaf (e.g. manifest.jsonl before it is written) is handled by
// resolving the longest existing ancestor and re-appending the remainder.
function canonicalize(absPath) {
  try {
    return realpathSync.native(absPath);
  } catch {
    const parent = dirname(absPath);
    if (parent === absPath) return absPath; // reached the filesystem root
    return join(canonicalize(parent), basename(absPath));
  }
}

// Return `path` relative to `cwd`, or null if it falls outside the worktree. Both
// sides are symlink-canonicalized first: without this, an ignore path recorded via
// a symlink alias of cwd (e.g. an evidence file stored as /var/... while
// process.cwd() reports /private/var/...) yields a spurious '../'-escaping relative
// path, silently drops out of the ignore set, and makes the worktree revision
// self-referential (it would hash evidence that itself embeds the revision).
function normalizeRelativePath(cwd, path) {
  const base = canonicalize(resolve(cwd));
  const target = canonicalize(resolve(cwd, path));
  const normalized = relative(base, target).replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

function ignoredPathSet(cwd, paths) {
  return new Set(
    [...DEFAULT_IGNORED_PATHS, ...paths]
      .map((path) => normalizeRelativePath(cwd, path))
      .filter(Boolean)
  );
}

function isIgnoredPath(relativePath, ignoredPaths) {
  const normalized = relativePath.replaceAll('\\', '/');
  return [...ignoredPaths].some((path) => normalized === path || normalized.startsWith(`${path}/`));
}

// ── Untracked-file refusal (#365 Decision 2 / AC15) ──────────────────────────────────────────
// The change-set identity deliberately excludes untracked files (they are not in the PR, so they
// cannot affect what merges — see the comment above resolveChangeSetRevision). But P5 prosecution
// EXECUTES a working tree, so an untracked test helper or scratch file can change what a review
// actually observed without moving the identity at all. Decision 2 closes that gap the other way:
// refuse to attest while an untracked-and-NOT-ignored file is present, decided from
// RUNTIME-VERIFIABLE STATE (is such a file present right now) rather than inferred by comparing
// digests — a digest mismatch carries no REASON, which is the same defect #364's AC5 criticised.
//
// `git ls-files --others --exclude-standard` already excludes gitignored paths, so `node_modules`
// (always present, always ignored) never triggers this — that exclusion is load-bearing: a check
// that fired on ignored files would brick prosecution permanently. `ignorePaths` lets a caller
// additionally exclude paths it EXPECTS to be untracked and legitimate (the manifest itself, an
// input file, a review transcript) — the same set already passed to resolveChangeSetRevision's
// ignorePaths for the identity, so "what the identity ignores" and "what this refusal tolerates"
// stay in sync by construction rather than by two independently-maintained lists.
export function untrackedNonIgnoredPaths({ cwd = process.cwd(), ignorePaths = [] } = {}) {
  const ignoredPaths = ignoredPathSet(cwd, ignorePaths);
  const untracked = splitNull(git(['ls-files', '--others', '--exclude-standard', '-z'], cwd));
  return untracked.filter((path) => !isIgnoredPath(path, ignoredPaths));
}

// ── Change-set identity (#365) ───────────────────────────────────────────────
// `resolveRevision` below hashes the WHOLE worktree, so an attestation binds to every file in
// the tree rather than to the change that was reviewed. Any advance of `main` invalidates a
// verdict for a change that has not moved: #362 lost one to a docs-only merge, #367 to a
// terminal-rendering merge. Both times the reviewed diff was byte-for-byte identical.
//
// This binds to `(base_sha, change_set_hash)` instead. Two premortem findings shape it:
//
// F2 — TREE-derived, never diff TEXT. `git diff --raw` reports the base and head MODE and BLOB
// SHA per changed path, straight from the tree objects. Hashing `git diff` output instead would
// make the identity depend on `diff.algorithm`, `core.autocrlf`, and the git version, which is
// the local-vs-CI divergence #362 and #367 were spent on. `--no-renames` is REQUIRED, not
// tidiness: `diff.renames` defaults to TRUE, and rename detection is a similarity HEURISTIC
// whose threshold varies — a rename would hash differently depending on configuration. With it
// off, a rename is always delete+add.
//
// F3 — mode is part of the identity. Both the source and destination mode are hashed, so a
// mode-only change (`chmod +x` on a hook) moves the identity. Normalizing it away would make
// that edit invisible after review.
//
// Untracked files are deliberately absent (unlike resolveRevision): they are not in the PR, so
// they cannot affect what merges, and including them is what made a local revision disagree with
// CI's clean checkout whenever scratch files were present. This matches classification exactly —
// `changedFiles` reads `git diff`, which also ignores untracked. The caller that attests a WORKING
// TREE is responsible for refusing an untracked-bearing one — see the prosecute local path.
//
// F5 — `base` is resolved HERE, by the gate, and embedded in the returned string. The value
// recorded in an attestation is therefore never consulted as authority; matching the full
// identity string is what proves the base agrees.
//
// BASIS — `base` → WORKING TREE, tracked paths only. NOT `base..HEAD`.
// An earlier build compared base to HEAD. It was reverted: prosecution here is
// working-tree-inclusive on purpose, proven by `FIX A` in
// packages/prosecute/test/prosecute-cross-model-cli.test.mjs, which asserts that an UNCOMMITTED
// edit to a trust-root file still tiers. A committed-only identity would describe something the
// gate does not prosecute — a fail-open. So the diff below takes ONE commit argument (compare to
// the working tree), never two.
//
// The CURRENT side is always COMPUTED, never read from `git diff --raw`. Measured against git
// 2.x, comparing a commit to the working tree reports `dstsha` as 40 zeros for an unstaged
// modification, a mode-only change, AND a symlink retarget alike — reading that field would
// collapse three distinct changes onto one identity. A STAGED modification does report a real
// sha, but it is the INDEX blob, which is stale the moment the file is edited again after
// staging. Neither is the working tree, so neither is trusted.
const CHANGE_SET_PREFIX = 'git-change';

// Current-side sentinel for a path that has no working-tree blob (a deletion). `git diff --raw`
// still lists a deleted path, but the file is gone from disk, so `hash-object`/`stat` must never
// be reached for it — that is a crash, and this primitive's try/catch would turn the crash into a
// silent null rather than a loud error.
const DELETED_MODE = '000000';
const NULL_OBJECT = '0'.repeat(40);

const REGULAR_MODES = new Set(['100644', '100755']);
const SYMLINK_MODE = '120000';

// A symlink's blob is the TARGET PATH STRING, which is what git itself stores — verified against
// `git ls-files -s` on a real symlink. It must NOT go through `hash-object <path>`, which opens
// and follows the link: for a symlink to a DIRECTORY that fails outright ("fatal: Unable to hash"),
// and for a dangling symlink it fails too. This is not hypothetical — this repo tracks
// `plugins/adlc-cursor/commands`, a symlink to a directory. No filters apply to a symlink blob, so
// `--stdin` (which applies none) is the faithful match.
function symlinkBlob(cwd, relativePath) {
  const target = readlinkSync(join(cwd, relativePath));
  return execFileSync('git', ['hash-object', '--stdin'], {
    cwd,
    input: target,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).toString('utf8').trim();
}

export function resolveChangeSetRevision({ cwd = process.cwd(), base, revision, ignorePaths = [] } = {}) {
  if (revision !== undefined && revision !== null && String(revision).trim() !== '') {
    return String(revision);
  }
  if (!base || String(base).trim() === '') return null;
  try {
    const baseSha = git(['rev-parse', String(base)], cwd).toString('utf8').trim();
    if (!baseSha) return null;
    // --raw: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0"
    // --abbrev=40 so blob shas are full, never abbreviated.
    // ONE commit argument: compare `base` to the WORKING TREE (see BASIS above).
    //
    // Pass the Buffer straight to splitNull/splitNulPaths — NOT a pre-decoded string. A premature
    // .toString('utf8') here lossily replaces any invalid byte sequence with U+FFFD before
    // splitNulPaths ever sees it, defeating its own fail-closed round-trip check (#249) for a
    // non-UTF-8 path. Every other NUL-delimited git() call in this file passes the raw Buffer for
    // the same reason (adversarial-review finding).
    const raw = splitNull(git(['diff', '--raw', '--no-renames', '--abbrev=40', '-z', baseSha], cwd));
    const ignoredPaths = ignoredPathSet(cwd, ignorePaths);
    const changed = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const meta = raw[i];
      const path = raw[i + 1];
      if (!meta || !path) continue;
      if (isIgnoredPath(path, ignoredPaths)) continue;
      // meta = ":<srcmode> <dstmode> <srcsha> <dstsha> <status>"
      const [srcMode, dstMode, srcSha] = meta.replace(/^:/, '').split(/\s+/);
      changed.push({ path, normalized: path.replaceAll('\\', '/'), srcMode, dstMode, srcSha });
    }

    // Regular files are hashed in ONE batched pass. Plain `hash-object <path>` (no `--path=`) is
    // deliberate: for a file already at its real working-tree location git applies that path's
    // own attributes and eol conversion — measured, `--path=` yields a byte-identical hash and
    // would force one process per file, since `--path` is singular and would otherwise apply one
    // path's attributes to every file in the batch. The repo pins `* text=auto eol=lf` in
    // .gitattributes, and attributes outrank `core.autocrlf`, which is what actually keeps a
    // Windows checkout agreeing with Linux CI here.
    const regular = changed.filter((entry) => REGULAR_MODES.has(entry.dstMode));
    const blobs = batchWorkingTreeBlobs(cwd, regular.map((entry) => entry.path));

    const entries = [];
    for (const entry of changed) {
      let currentObject;
      if (entry.dstMode === DELETED_MODE) {
        currentObject = NULL_OBJECT;
      } else if (entry.dstMode === SYMLINK_MODE) {
        currentObject = symlinkBlob(cwd, entry.path);
      } else if (REGULAR_MODES.has(entry.dstMode)) {
        currentObject = blobs.get(entry.path);
      } else {
        // A gitlink (160000) or any mode git grows later. Fail CLOSED rather than invent a
        // representation: no identity means the gate finds no attestation and refuses, which is
        // the safe direction. Inventing one risks two distinct trees sharing an identity.
        return null;
      }
      if (!currentObject) return null;
      entries.push(
        [entry.normalized, entry.srcMode, entry.srcSha, entry.dstMode, currentObject].join(' ')
      );
    }
    // Sort so the identity is independent of git's output ordering.
    entries.sort();
    const hash = newHash();
    for (const entry of entries) hash.add(Buffer.from(entry));
    return `${CHANGE_SET_PREFIX}:${baseSha}:${hash.digest()}`;
  } catch {
    return null;
  }
}

/** True for an identity produced by resolveChangeSetRevision (vs the legacy whole-worktree form). */
export function isChangeSetRevision(revision) {
  return typeof revision === 'string' && revision.startsWith(`${CHANGE_SET_PREFIX}:`);
}

/** The base sha a change-set identity was reviewed against, or null for any other form. */
export function changeSetBase(revision) {
  if (!isChangeSetRevision(revision)) return null;
  return String(revision).split(':')[1] || null;
}

/** The change-set component — equal across two identities whose reviewed change is the same. */
export function changeSetDigest(revision) {
  if (!isChangeSetRevision(revision)) return null;
  const parts = String(revision).split(':');
  return parts[2] || null;
}

export function resolveRevision({ cwd = process.cwd(), revision, ignorePaths = [] } = {}) {
  if (revision !== undefined && revision !== null && String(revision).trim() !== '') {
    return String(revision);
  }

  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    const tracked = trackedEntries(cwd);
    const dirtyTracked = dirtyTrackedPaths(cwd);
    const untracked = splitNull(git(['ls-files', '--others', '--exclude-standard', '-z'], cwd));
    const hash = newHash();
    const ignoredPaths = ignoredPathSet(cwd, ignorePaths);
    const files = new Set([
      ...tracked.keys(),
      ...untracked,
    ]);
    const sortedFiles = Array.from(files).sort();
    const workingTreeBlobIds = batchWorkingTreeBlobs(
      cwd,
      sortedFiles.filter((relative) => {
        if (isIgnoredPath(relative, ignoredPaths)) return false;
        const trackedEntry = tracked.get(relative);
        if (trackedEntry && !dirtyTracked.has(relative)) return false;
        try {
          return statSync(join(cwd, relative)).isFile();
        } catch {
          return false;
        }
      })
    );

    for (const relative of sortedFiles) {
      if (isIgnoredPath(relative, ignoredPaths)) continue;
      try {
        const trackedEntry = tracked.get(relative);
        if (trackedEntry && !dirtyTracked.has(relative)) {
          addGitBlob(hash, relative, trackedEntry);
        } else {
          addWorkingTreeFile(hash, cwd, relative, workingTreeBlobIds.get(relative));
        }
      } catch {
        hash.add(Buffer.from(relative));
        hash.add(Buffer.from('missing'));
      }
    }
    return `git-worktree:${hash.digest()}`;
  } catch {
    return null;
  }
}
