// store.mjs — delegates locking and atomic JSON staging to @adlc/tickets leaf
// primitives so ticket-prune interoperates on .adlc/tickets.lock with zero duplication.

import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireTicketLock, releaseTicketLock } from '@adlc/tickets/lib/lock.mjs';
import { durableWrite, durableRename } from '@adlc/tickets/lib/durability.mjs';

const LOCK_DIR = '.adlc/tickets.lock';
const heldLocks = new Map();

/** Acquire the shared ticket lock at `.adlc/tickets.lock`. */
export function acquireLock(dir = '.', options = {}) {
  const key = resolve(dir);
  try {
    const lock = acquireTicketLock(dir, { ...options, command: 'ticket-prune' });
    heldLocks.set(key, lock);
    return true;
  } catch (err) {
    if (err?.code === 'LOCK_TIMEOUT') return false;
    throw err;
  }
}

export function releaseLock(dir = '.') {
  const key = resolve(dir);
  const lock = heldLocks.get(key);
  if (lock) {
    heldLocks.delete(key);
    releaseTicketLock(lock);
    return;
  }
  try {
    rmSync(join(dir, LOCK_DIR), { recursive: true, force: true });
  } catch {
    /* already released */
  }
}

/**
 * Stage `obj` next to `path` and hand back the two ways to finish: `commit`
 * renames it into place, `discard` removes the staged copy.
 */
export function stageJsonAtomic(path, obj) {
  const tmp = `${path}.tmp.${process.pid}`;
  durableWrite(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  return {
    commit: () => durableRename(tmp, path),
    discard: () => { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } },
  };
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
