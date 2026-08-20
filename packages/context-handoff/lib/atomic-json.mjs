/**
 * Atomic JSON write-then-rename (process-unique tmp sibling).
 */

import {
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Hex byte count for unique tmp suffixes (load-bearing for hollow coverage). */
export const TMP_HEX_BYTES = 8;

function uniqueTmpPath(finalPath) {
  return `${finalPath}.${process.pid}.${randomBytes(TMP_HEX_BYTES).toString('hex')}.tmp`;
}

function tryUnlinkTmp(tmp, fs) {
  if (!tmp) return;
  try {
    if (typeof fs.unlinkSync === 'function') fs.unlinkSync(tmp);
  } catch {
    // best-effort
  }
}

/**
 * Atomically write text to path (write-then-rename through a unique tmp).
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeTextAtomic(
  path,
  text,
  {
    fs = { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync },
  } = {},
) {
  const tmp = uniqueTmpPath(path);
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, path);
    // The bytes are the WRITE's own, not a later disk read: an ownership token
    // sampled from the path after the fact can adopt a concurrent writer's
    // replacement as "ours" and let a rollback delete it.
    return { ok: true, bytes: text };
  } catch (err) {
    tryUnlinkTmp(tmp, fs);
    return { ok: false, error: err?.code || err?.message || 'write_failed' };
  }
}

/**
 * Atomically write pretty-printed JSON (+ trailing newline) to path.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeJsonAtomic(path, value, opts = {}) {
  return writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, opts);
}

/**
 * Create a file that must not already exist (O_EXCL).
 *
 * `exists` is the whole point: an exists-then-write pair has a window between
 * the two in which another process can win, so a claim that must be exclusive
 * has to be made by the create itself. Not atomic-rename — a rename would
 * happily replace the file it is racing.
 *
 * @returns {{ ok: true } | { ok: false, error: string, exists?: boolean }}
 */
export function writeTextExclusive(
  path,
  text,
  { fs = { mkdirSync, writeFileSync } } = {},
) {
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, bytes: text };
  } catch (err) {
    const code = err?.code || err?.message || 'write_failed';
    return { ok: false, error: code, exists: code === 'EEXIST' };
  }
}

/**
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function readTextFile(path, { fs = { readFileSync, existsSync } } = {}) {
  if (!fs.existsSync(path)) {
    return { ok: false, error: 'missing' };
  }
  try {
    return { ok: true, text: fs.readFileSync(path, 'utf8') };
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || 'unreadable' };
  }
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function readJsonFile(path, opts = {}) {
  const got = readTextFile(path, opts);
  if (!got.ok) return got;
  try {
    const value = JSON.parse(got.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'invalid_shape' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: 'corrupt_json' };
  }
}
