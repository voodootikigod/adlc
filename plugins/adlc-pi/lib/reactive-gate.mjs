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
import { findSuppressions, isMarkerAllowed, isDocFile, isMdxFile, stripInlineCode } from '@adlc/rails-guard/lib/suppressions.mjs';
import { TRUST_ROOT_RAILS, SUPPRESSION_MARKERS, canonicalizePath } from './rails-checker.mjs';

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

/**
 * Markers present on OPERATIVE lines of a file's content (spec Phase 2
 * banked P5 finding). Prose .md is never operative; .mdx fenced blocks and
 * inline code spans are inert; every line of a code file is operative.
 * Returns Map<marker, {lineNo, content}> of the first operative occurrence.
 */
export function operativeMarkerSet(content, file) {
  const out = new Map();
  if (isDocFile(file)) return out;
  const text = String(content ?? '');
  if (text === '') return out;
  const mdx = isMdxFile(file);
  const fenced = mdx ? computeFencedLines(text) : null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (mdx && fenced.has(i + 1)) continue;
    const scan = mdx ? stripInlineCode(lines[i]) : lines[i];
    for (const marker of SUPPRESSION_MARKERS) {
      if (!out.has(marker) && scan.includes(marker)) {
        out.set(marker, { lineNo: i + 1, content: lines[i] });
      }
    }
  }
  return out;
}

/**
 * Position-aware suppression delta: flags a marker that became OPERATIVE in
 * the new content without having been operative in the old — catching a
 * pre-existing identical marker line RELOCATED out of an inert position
 * (e.g. out of a fenced block), which the added-lines multiset diff cannot
 * see. The reverse move (operative → inert) is never flagged.
 */
export function scanOperativeDelta(oldContent, newContent, file, allowedMarkers, ticketBody) {
  const after = operativeMarkerSet(newContent, file);
  if (after.size === 0) return [];
  const before = operativeMarkerSet(oldContent, file);
  const violations = [];
  for (const [marker, where] of after) {
    if (before.has(marker)) continue;
    if (allowedMarkers.includes(marker) || isMarkerAllowed(marker, ticketBody ?? '')) continue;
    violations.push({ file, lineNo: where.lineNo, marker, content: where.content });
  }
  return violations;
}

/** Merge violation lists, dropping duplicate (file, marker) pairs. */
export function mergeViolations(...lists) {
  const seen = new Set();
  const out = [];
  for (const violation of lists.flat()) {
    const key = `${violation.file}\u0000${violation.marker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(violation);
  }
  return out;
}

const GIT_C_ESCAPES = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

/** Decode a git C-quoted path (when `core.quotePath` wraps non-ASCII/special paths in `"..."`). */
export function unquoteGitPath(rawPath) {
  const str = String(rawPath ?? "");
  if (str.length < 2 || !str.startsWith('"') || !str.endsWith('"')) return str;
  const inner = str.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next >= "0" && next <= "7" && i + 3 < inner.length) {
        const d2 = inner[i + 2];
        const d3 = inner[i + 3];
        if (d2 >= "0" && d2 <= "7" && d3 >= "0" && d3 <= "7") {
          bytes.push(parseInt(next + d2 + d3, 8));
          i += 3;
          continue;
        }
      }
      if (Object.hasOwn(GIT_C_ESCAPES, next)) {
        bytes.push(GIT_C_ESCAPES[next]);
        i += 1;
        continue;
      }
    }
    bytes.push(...Buffer.from(ch, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

function extractPorcelainTarget(entry) {
  if (entry.startsWith('"')) {
    for (let i = 1; i < entry.length; i++) {
      if (entry[i] === "\\") { i += 1; continue; }
      if (entry[i] === '"') {
        if (entry.slice(i + 1, i + 5) === " -> ") return entry.slice(i + 5);
        return entry;
      }
    }
  }
  const arrow = entry.indexOf(" -> ");
  return arrow === -1 ? entry : entry.slice(arrow + 4);
}

/** Parse `git status --porcelain` output into repo-relative paths. */
export function parsePorcelain(stdout) {
  const files = [];
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // Format: XY <path> (or XY <old> -> <new> for renames — take the new side).
    const entry = raw.slice(3);
    files.push(unquoteGitPath(extractPorcelainTarget(entry)));
  }
  return files;
}

/** Hash a working-tree file (null when absent/unreadable) for touched-set detection. */
export function fileStamp(root, path) {
  const abs = absPath(root, path);
  if (!existsSync(abs)) return null;
  try { return sha256(readFileSync(abs)); } catch { return "unreadable"; }
}

/**
 * Enumerate working-tree files that belong to the frozen rail set (trust roots
 * + the ticket's rail globs), from `git ls-files` + `git status --porcelain`
 * output (tracked + untracked). Returns repo-relative paths that exist.
 */
export function listRailFiles(root, ticket, lsFilesOut, statusOut) {
  const candidates = new Set([
    ...String(lsFilesOut ?? "").split(/\r?\n/).map((s) => unquoteGitPath(s.trim())).filter(Boolean),
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
