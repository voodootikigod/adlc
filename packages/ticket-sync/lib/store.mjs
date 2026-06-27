// store.mjs — atomic writes + the shared lock + the sync-state sidecar (zero-dep).
//
// The `/adlc-ticket` command documents a mkdir lock + temp-rename "protocol" only
// as prose; there is no shared writer in @adlc/core (frozen). This re-implements
// it as real code, sharing the SAME `.adlc/tickets.lock` directory-lock path so
// the two writers interoperate. The sidecar is a gitignored rebuildable cache and
// is NOT a rail — routine sync writes here never touch the trust root.

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_DIR = '.adlc/tickets.lock';
const SIDECAR = '.adlc/ticket-sync.state.json';
const TICKETS = '.adlc/tickets.json';

/** Zero-dep synchronous sleep (no busy-wait) for lock retry backoff. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Acquire the mkdir lock (atomic; one winner). Bounded retry, then false. */
export function acquireLock(dir = '.', { retries = 50, delayMs = 20 } = {}) {
  const path = join(dir, LOCK_DIR);
  for (let i = 0; i <= retries; i++) {
    try {
      mkdirSync(path);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
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

/** Atomically replace .adlc/tickets.json (caller must hold the lock). */
export function writeTicketsAtomic(dir, ticketsObj) {
  writeAtomic(join(dir, TICKETS), `${JSON.stringify(ticketsObj, null, 2)}\n`);
}

const EMPTY_SIDECAR = { version: 1, tickets: {}, pendingCreates: {} };

/** Read the sidecar; an absent or corrupt sidecar yields the empty cache (rebuildable). */
export function readSidecar(dir = '.') {
  const path = join(dir, SIDECAR);
  if (!existsSync(path)) return { ...EMPTY_SIDECAR };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { ...EMPTY_SIDECAR, ...parsed };
  } catch {
    return { ...EMPTY_SIDECAR };
  }
}

export function writeSidecar(dir, state) {
  writeAtomic(join(dir, SIDECAR), `${JSON.stringify(state, null, 2)}\n`);
}
