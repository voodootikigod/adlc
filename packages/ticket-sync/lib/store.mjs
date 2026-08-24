// store.mjs — atomic writes + the shared lock + the sync-state sidecar (zero-dep).
//
// The `/adlc-ticket` command documents a mkdir lock + temp-rename "protocol" only
// as prose; there is no shared writer in @adlc/core (frozen). This re-implements
// it as real code, sharing the SAME `.adlc/tickets.lock` directory-lock path so
// the two writers interoperate. The sidecar is a gitignored rebuildable cache and
// is NOT a rail — routine sync writes here never touch the trust root.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertSignableTrustRootWrite,
  TicketService,
  acquireTicketLock,
  conflict,
  detectTicketStore,
  durableRename,
  durableWrite,
  initializeTicketStores,
  operational,
  releaseTicketLock,
} from '@adlc/tickets';
import { validateSyncState } from './validate.mjs';

const SIDECAR = '.adlc/ticket-sync.state.json';

const heldLocks = new Map();

/** Acquire the mkdir lock (atomic; one winner). Bounded retry, then false. */
export function acquireLock(dir = '.', { retries = 50, delayMs = 20 } = {}) {
  const key = resolve(dir);
  if (heldLocks.has(key)) return false;
  try {
    heldLocks.set(key, acquireTicketLock(dir, { retries, delayMs, command: 'ticket-sync' }));
    return true;
  } catch (error) {
    if (error.code === 'LOCK_TIMEOUT') return false;
    throw error;
  }
}

export function releaseLock(dir = '.') {
  const key = resolve(dir);
  const lock = heldLocks.get(key);
  if (!lock) return;
  releaseTicketLock(lock);
  heldLocks.delete(key);
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp.${process.pid}`;
  durableWrite(tmp, text);
  durableRename(tmp, path);
}

/** Atomically replace .adlc/tickets.json (caller must hold the lock). */
export function writeTicketsAtomic(dir, ticketsObj, { expectedSnapshotHash, expectedStoreAbsent = false, key = null, allowUnsigned = false } = {}) {
  let store;
  let storeWasAbsent = false;
  try { store = detectTicketStore({ root: dir }); }
  catch (error) {
    if (error.code !== 'STORE_NOT_FOUND') throw error;
    // BEFORE creating anything. With no store there are no tickets to declare a
    // rail, but the repo can still be a trust root through its archive or a recorded
    // override — and initializing first would leave `.adlc/tickets/` and
    // `.adlc/ticket-archive/` behind for a write that is then refused. "Refusing
    // before the write" has to mean the whole operation, here as in archiveTicket.
    assertSignableTrustRootWrite([], { key, allowUnsigned, root: dir });
    storeWasAbsent = true;
    initializeTicketStores(dir);
    store = detectTicketStore({ root: dir });
  }
  if (expectedStoreAbsent && !storeWasAbsent) throw conflict('STALE_SNAPSHOT', 'ticket store appeared after synchronization planning');
  const service = new TicketService(store, { root: dir, key, allowUnsigned });
  const plan = service.planReconciliation(ticketsObj.tickets, { authorized: true, expectedSnapshotHash });
  return service.apply(plan, { lock: heldLocks.get(resolve(dir)) ?? null });
}

const EMPTY_SIDECAR = { version: 1, tickets: {}, pendingCreates: {} };

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function sidecarErrors(parsed) {
  const errors = validateSyncState(parsed);
  if (parsed?.version !== 1) errors.push('version: unsupported sidecar format');
  for (const [id, entry] of Object.entries(isRecord(parsed?.tickets) ? parsed.tickets : {})) {
    if (!isRecord(entry)) errors.push(`tickets.${id}: expected object`);
  }
  for (const [key, pending] of Object.entries(isRecord(parsed?.pendingCreates) ? parsed.pendingCreates : {})) {
    if (!isRecord(pending)) {
      errors.push(`pendingCreates.${key}: expected object`);
      continue;
    }
    if (typeof pending.localId !== 'string' || !pending.localId) errors.push(`pendingCreates.${key}.localId: required string`);
    if (pending.number !== undefined && (!Number.isInteger(pending.number) || pending.number <= 0)) errors.push(`pendingCreates.${key}.number: expected positive integer`);
  }
  return errors;
}

/**
 * Read the sidecar. Read-only flows may rebuild ordinary cache state after
 * corruption, but writers fail closed because pendingCreates is a recovery log
 * until ID reassignment and evidence re-attestation both finish.
 */
export function readSidecar(dir = '.', { strict = false } = {}) {
  const path = join(dir, SIDECAR);
  if (!existsSync(path)) return { ...EMPTY_SIDECAR };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (strict) throw operational('SIDECAR_CORRUPT', `cannot safely continue with corrupt ${SIDECAR}: ${error.message}`);
    return { ...EMPTY_SIDECAR };
  }
  const errors = sidecarErrors(parsed);
  if (errors.length) {
    if (strict) throw operational('SIDECAR_CORRUPT', `cannot safely continue with invalid ${SIDECAR}: ${errors.join('; ')}`);
    return { ...EMPTY_SIDECAR };
  }
  return { ...EMPTY_SIDECAR, ...parsed };
}

export function writeSidecar(dir, state) {
  writeAtomic(join(dir, SIDECAR), `${JSON.stringify(state, null, 2)}\n`);
}
