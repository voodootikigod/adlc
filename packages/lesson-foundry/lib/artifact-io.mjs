// artifact-io.mjs — reading and writing lesson artifacts.

import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * True when an artifact's text can defend anything: a string with at least one
 * non-whitespace character. The gate and the --write preserve rule share this
 * floor, so an artifact the gate refuses to credit is never kept as if it were
 * hand-refined.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasDefenseContent(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

/**
 * The artifact's text, or null when it cannot be read.
 * @param {string} path
 * @returns {string|null}
 */
export function readArtifact(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write via a sibling temp file and rename, so an interrupted write leaves the
 * previous file (or none) rather than a truncated one.
 *
 * @param {string} path
 * @param {string} content
 */
export function writeFileAtomic(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}
