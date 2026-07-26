import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCK_DIRECTORY } from './constants.mjs';
import { conflict, operational } from './errors.mjs';

const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

export function acquireTicketLock(root = '.', { retries = 50, delayMs = 20, command = process.argv.join(' '), transactionId = null } = {}) {
  const path = join(root, LOCK_DIRECTORY);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      mkdirSync(path);
      const metadata = { version: 1, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), command, transactionId };
      writeFileSync(join(path, 'owner.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
      return { path, metadata };
    } catch (error) {
      if (error.code !== 'EEXIST') throw operational('LOCK_FAILED', `cannot acquire ticket lock: ${error.message}`);
      if (attempt < retries) sleep(delayMs);
    }
  }
  throw conflict('LOCK_TIMEOUT', `could not acquire ${LOCK_DIRECTORY}; another ticket writer is running`, readTicketLock(root));
}

/**
 * The lock owner's metadata, or null when unlocked, unreadable, or malformed.
 *
 * VALIDATED, because index.d.ts publishes the shape: it declares numeric
 * pid/version and the rest of TicketLockMetadata, while this only JSON-parsed
 * whatever was on disk. `owner.json` containing the valid JSON string "stale"
 * therefore satisfied the compiler and crashed the caller on `.pid` — and the
 * file is attacker-controlled in an untrusted workspace. A declaration wider
 * than its implementation moves the failure past the compiler, so the
 * implementation moves to meet it: an unrecognized shape reads as no lock.
 */
export function readTicketLock(root = '.') {
  let parsed;
  try { parsed = JSON.parse(readFileSync(join(root, LOCK_DIRECTORY, 'owner.json'), 'utf8')); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!Number.isInteger(parsed.pid)) return null;
  if (typeof parsed.hostname !== 'string' || typeof parsed.startedAt !== 'string') return null;
  if (typeof parsed.command !== 'string') return null;
  if (parsed.transactionId !== null && typeof parsed.transactionId !== 'string') return null;
  return parsed;
}

export function releaseTicketLock(lock) {
  if (!lock?.path) return;
  let owner;
  try { owner = JSON.parse(readFileSync(join(lock.path, 'owner.json'), 'utf8')); } catch { return; }
  if (owner.pid !== lock.metadata.pid || owner.startedAt !== lock.metadata.startedAt) return;
  rmSync(lock.path, { recursive: true, force: true });
}
