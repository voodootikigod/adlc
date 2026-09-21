/**
 * snapshot.mjs — Read and restore file contents.
 * Pure operations around a snapshot map: { [path]: string }.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyHunks } from './hunks.mjs';

/**
 * Write file atomically using write-temp-then-rename in the same directory.
 * Cleans up temp file on failure.
 */
export function writeFileAtomic(filePath, content) {
  const dir = dirname(filePath);
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Capture the current content of each path.
 * Returns { path: content } map.
 */
export function takeSnapshot(paths) {
  const snap = {};
  for (const p of paths) {
    snap[p] = readFileSync(p, 'utf8');
  }
  return snap;
}

/**
 * Write each path back to its snapshot content.
 * Always restores all paths regardless of errors on individual writes.
 */
export function restoreSnapshot(snapshot) {
  const errors = [];
  for (const [p, content] of Object.entries(snapshot)) {
    try {
      writeFileAtomic(p, content);
    } catch (err) {
      errors.push(`restore failed for ${p}: ${err.message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

/**
 * Apply a set of hunk-based changes from an LLM candidate (issue #279).
 * changes: [{ file, hunks: [{startLine, endLine, replacement}] }]
 *
 * Only writes files whose paths are in the snapshot — a candidate
 * referencing an unlisted file is a validation bug upstream (validateCandidate
 * should have caught it already) and throws, unlike a hunk that fails to
 * apply cleanly, which is an EXPECTED per-candidate outcome (a candidate's
 * hunk coordinates don't match reality, e.g. an off-by-one or a reference to
 * an excerpt-omitted line) and is reported back via the return value instead
 * of thrown, so the caller can disqualify just that one candidate.
 *
 * @param {Array<{file:string, hunks:Array}>} changes
 * @param {{[path]: string}} snapshot
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function applyChanges(changes, snapshot) {
  for (const { file, hunks } of changes) {
    if (!(file in snapshot)) {
      throw new Error(`candidate referenced file not in provided list: ${file}`);
    }
    const result = applyHunks(snapshot[file], hunks);
    if (!result.ok) return { ok: false, error: `${file}: ${result.error}` };
    writeFileAtomic(file, result.content);
  }
  return { ok: true };
}
