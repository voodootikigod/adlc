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

export function readTicketLock(root = '.') {
  try { return JSON.parse(readFileSync(join(root, LOCK_DIRECTORY, 'owner.json'), 'utf8')); } catch { return null; }
}

export function releaseTicketLock(lock) {
  if (!lock?.path) return;
  let owner;
  try { owner = JSON.parse(readFileSync(join(lock.path, 'owner.json'), 'utf8')); } catch { return; }
  if (owner.pid !== lock.metadata.pid || owner.startedAt !== lock.metadata.startedAt) return;
  rmSync(lock.path, { recursive: true, force: true });
}
