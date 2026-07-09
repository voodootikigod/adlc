// reactive-gate.mjs — the post-tool verification layer, snapshot-based.
//
// Blast-radius contract (ticket T21): the gate never touches a file the tool
// did not write. Structured writes are snapshotted at tool_call time and a
// violation restores exactly that snapshot — never `git checkout HEAD` (which
// would destroy the user's own uncommitted edits). Bash calls snapshot the
// (small) frozen-rail file set before execution; only files that actually
// changed during the call are inspected, so pre-existing user edits are never
// attributed to the agent. No git intent-to-add staging side effects —
// untracked files are seen via `git status --porcelain`.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { sha256, globMatch, computeFencedLines } from '@adlc/core';
import { findSuppressions, isMarkerAllowed } from '@adlc/rails-guard/lib/suppressions.mjs';
import { TRUST_ROOT_RAILS, canonicalizePath } from './rails-checker.mjs';

// Snapshot caps: rails sets are small in practice; degrade loudly, not silently.
export const SNAPSHOT_BYTE_CAP = 8 * 1024 * 1024;
export const BASH_SCAN_FILE_CAP = 50;

function absPath(root, p) {
  return isAbsolute(p) ? p : join(root, p);
}

/** Snapshot one file's current state (content, or its absence). */
export function snapshotFile(root, path) {
  const abs = absPath(root, path);
  if (!existsSync(abs)) return { path, existed: false, content: null };
  try {
    return { path, existed: true, content: readFileSync(abs, 'utf8') };
  } catch {
    // Unreadable (binary/permission) — record existence without content; a
    // restore for this snapshot is impossible and must be reported, not faked.
    return { path, existed: true, content: null, unreadable: true };
  }
}

/**
 * Restore a snapshot exactly: rewrite the captured content, or remove the file
 * a tool created. Returns false when the snapshot cannot be restored
 * (unreadable capture) so the caller reports instead of pretending.
 */
export function restoreSnapshot(root, snap) {
  const abs = absPath(root, snap.path);
  if (!snap.existed) {
    try { if (existsSync(abs)) unlinkSync(abs); return true; } catch { return false; }
  }
  if (snap.content === null) return false;
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, snap.content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Added lines of `newContent` relative to `oldContent`: the multiset
 * difference by line (a line occurring more often than before counts, so a
 * duplicated marker line is still caught). Deterministic, no git dependency;
 * reordering may over-report (fail closed), never under-report an occurrence
 * count increase.
 * Returns [ { file, lineNo, content } ] with 1-based line numbers in the new file.
 */
export function diffAddedLines(oldContent, newContent, file) {
  const oldCounts = new Map();
  for (const line of String(oldContent ?? '').split(/\r?\n/)) {
    oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  }
  const added = [];
  const newLines = String(newContent ?? '').split(/\r?\n/);
  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i];
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) {
      oldCounts.set(line, remaining - 1);
    } else {
      added.push({ file, lineNo: i + 1, content: line });
    }
  }
  return added;
}

/**
 * Scan added lines for suppression markers the ticket does not allow.
 * Delegates operative-vs-inert to @adlc/rails-guard's shared gate logic
 * (prose .md exempt; .mdx fenced blocks / inline spans inert via the
 * authoritative full-file fence derivation from @adlc/core).
 */
export function scanAddedLines(addedLines, newContentByFile, allowedMarkers, ticketBody) {
  const fencedCache = new Map();
  const isFenced = (file, lineNo) => {
    if (!fencedCache.has(file)) {
      fencedCache.set(file, computeFencedLines(newContentByFile.get(file) ?? ''));
    }
    return fencedCache.get(file).has(lineNo);
  };
  return findSuppressions(addedLines, { isFenced }).filter(
    (v) => !allowedMarkers.includes(v.marker) && !isMarkerAllowed(v.marker, ticketBody ?? '')
  );
}

/** Parse `git status --porcelain` output into repo-relative paths. */
export function parsePorcelain(stdout) {
  const files = [];
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // Format: XY <path> (or XY <old> -> <new> for renames — take the new side).
    const entry = raw.slice(3);
    const arrow = entry.indexOf(' -> ');
    const path = arrow === -1 ? entry : entry.slice(arrow + 4);
    files.push(path.replace(/^"|"$/g, ''));
  }
  return files;
}

/** Hash a working-tree file (null when absent/unreadable) for touched-set detection. */
export function fileStamp(root, path) {
  const abs = absPath(root, path);
  if (!existsSync(abs)) return null;
  try { return sha256(readFileSync(abs)); } catch { return 'unreadable'; }
}

/**
 * Enumerate working-tree files that belong to the frozen rail set (trust roots
 * + the ticket's rail globs), from `git ls-files` + `git status --porcelain`
 * output (tracked + untracked). Returns repo-relative paths that exist.
 */
export function listRailFiles(root, ticket, lsFilesOut, statusOut) {
  const candidates = new Set([
    ...String(lsFilesOut ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    ...parsePorcelain(statusOut),
  ]);
  const rails = ticket?.rails ?? [];
  const matched = new Set();
  for (const file of candidates) {
    const canonical = canonicalizePath(file, root);
    if (TRUST_ROOT_RAILS.includes(canonical) || rails.some((r) => globMatch(r, canonical))) {
      if (existsSync(absPath(root, file))) matched.add(canonical);
    }
  }
  for (const trustRoot of TRUST_ROOT_RAILS) {
    if (existsSync(absPath(root, trustRoot))) matched.add(trustRoot);
  }
  return [...matched];
}

/**
 * Snapshot the rail file set before an allowed mutating bash command, plus a
 * stamp of every currently-dirty file so the touched set after the call can be
 * attributed to the call alone. Degrades loudly past the byte cap.
 */
export function snapshotForBash(root, ticket, lsFilesOut, statusOut) {
  const railFiles = new Map();
  let bytes = 0;
  let degraded = false;
  for (const path of listRailFiles(root, ticket, lsFilesOut, statusOut)) {
    const snap = snapshotFile(root, path);
    bytes += snap.content?.length ?? 0;
    if (bytes > SNAPSHOT_BYTE_CAP) { degraded = true; break; }
    railFiles.set(path, snap);
  }
  const preStamps = new Map();
  for (const path of parsePorcelain(statusOut)) {
    preStamps.set(path, fileStamp(root, path));
  }
  return { kind: 'bash', railFiles, preStamps, degraded };
}

/** Files that changed during the call: new/changed vs the pre-call stamps. */
export function touchedSince(root, preStamps, postStatusOut) {
  const touched = [];
  for (const path of parsePorcelain(postStatusOut)) {
    const now = fileStamp(root, path);
    if (!preStamps.has(path) || preStamps.get(path) !== now) touched.push(path);
  }
  return touched;
}
