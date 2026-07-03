// store.mjs — local lock + atomic JSON write for the tickets.json writer
// contract. Core is frozen (CONVENTIONS rule 2) and has no shared writer for
// .adlc/tickets.json, so this re-implements the same mkdir-lock + tmp-rename
// protocol @adlc/ticket-sync's lib/store.mjs uses, at the SAME lock path
// (.adlc/tickets.lock) so the two writers interoperate instead of racing each
// other. See this package's README "Core gaps" section.

import {
  mkdirSync,
  rmdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const LOCK_DIR = '.adlc/tickets.lock';

/** Zero-dependency synchronous sleep (no busy-wait) for lock retry backoff. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Acquire the shared mkdir lock (atomic; exactly one winner). */
export function acquireLock(dir = '.', { retries = 50, delayMs = 20 } = {}) {
  const path = join(dir, LOCK_DIR);
  // Ensure the .adlc/ parent exists (idempotent — does not affect the
  // exclusivity check below, which relies on plain mkdirSync's EEXIST).
  mkdirSync(dirname(path), { recursive: true });
  for (let i = 0; i <= retries; i++) {
    try {
      mkdirSync(path);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (i < retries) sleepSync(delayMs);
    }
  }
  return false;
}

export function releaseLock(dir = '.') {
  try {
    rmdirSync(join(dir, LOCK_DIR));
  } catch {
    /* already released */
  }
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Pretty-print JSON with a trailing newline and write it atomically. */
export function writeJsonAtomic(path, obj) {
  writeAtomic(path, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Read + parse JSON at `path`; return `fallback` if the file is absent. */
export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${err.message}`);
  }
}
