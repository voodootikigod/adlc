/**
 * snapshot.mjs — Read and restore file contents.
 * Pure operations around a snapshot map: { [path]: string }.
 */

import { readFileSync, writeFileSync } from 'node:fs';

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
      writeFileSync(p, content, 'utf8');
    } catch (err) {
      errors.push(`restore failed for ${p}: ${err.message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

/**
 * Apply a set of changes from an LLM candidate.
 * changes: [{ file, content }]
 * Only writes files whose paths are in the snapshot.
 */
export function applyChanges(changes, snapshot) {
  for (const { file, content } of changes) {
    if (!(file in snapshot)) {
      throw new Error(`candidate referenced file not in provided list: ${file}`);
    }
    writeFileSync(file, content, 'utf8');
  }
}
