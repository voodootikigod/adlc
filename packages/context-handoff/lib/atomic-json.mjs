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
 * Atomically write pretty-printed JSON (+ trailing newline) to path.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeJsonAtomic(
  path,
  value,
  {
    fs = { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync },
  } = {},
) {
  const tmp = uniqueTmpPath(path);
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    tryUnlinkTmp(tmp, fs);
    return { ok: false, error: err?.code || err?.message || 'write_failed' };
  }
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function readJsonFile(path, { fs = { readFileSync, existsSync } } = {}) {
  if (!fs.existsSync(path)) {
    return { ok: false, error: 'missing' };
  }
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || 'unreadable' };
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'invalid_shape' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: 'corrupt_json' };
  }
}
