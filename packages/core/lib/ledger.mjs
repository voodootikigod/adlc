// Append-only JSONL ledgers under .adlc/ — the shared persistence layer for
// gate-manifest entries, prosecution findings, routing priors, etc.

import { appendFileSync, existsSync, mkdirSync, readFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const ADLC_DIR = '.adlc';

export function ledgerPath(name, dir = ADLC_DIR) {
  return join(dir, `${name}.jsonl`);
}

// appendFileSync is only atomic for writes under PIPE_BUF (~4KB). Manifest
// entries embed per-file hashes and routinely exceed that, so concurrent
// writers from parallel build lanes can interleave and corrupt lines. An
// advisory lockfile serialises writers across processes.
const LOCK_RETRY_DELAY_MS = 5;
const LOCK_MAX_RETRIES = 400; // ~2s ceiling
const LOCK_STALE_MS = 30_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` while holding an advisory lock on `${target}.lock`. */
export function withLedgerLock(target, fn) {
  const lockPath = `${target}.lock`;
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx'); // fails if lock already held
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Steal a stale lock left by a crashed writer.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock vanished between open and stat — just retry
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
      continue;
    }
    try {
      closeSync(fd);
      return fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // best effort
      }
    }
  }
  throw new Error(`could not acquire ledger lock: ${lockPath} (held > ${LOCK_MAX_RETRIES * LOCK_RETRY_DELAY_MS}ms)`);
}

/** Append one entry (object) to the named ledger. Creates dir/file as needed. */
export function appendEntry(name, entry, dir = ADLC_DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = ledgerPath(name, dir);
  withLedgerLock(p, () => {
    appendFileSync(p, JSON.stringify(entry) + '\n');
  });
  return entry;
}

/**
 * Read all entries. Malformed lines are never silently swallowed: they are
 * returned in `skipped` with line numbers so callers can surface them.
 * Returns { entries, skipped }.
 */
export function readEntries(name, dir = ADLC_DIR) {
  const p = ledgerPath(name, dir);
  if (!existsSync(p)) return { entries: [], skipped: [] };
  const entries = [];
  const skipped = [];
  const lines = readFileSync(p, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      skipped.push({ line: i + 1, error: String(err.message ?? err) });
    }
  }
  return { entries, skipped };
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJsonValue(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalizeJsonValue(value));
}

/** Hash a list of files → { path: sha256 }. Missing files hash to null. */
export function hashFiles(paths, readFile = (p) => readFileSync(p)) {
  const out = {};
  for (const p of paths) {
    try {
      out[p] = sha256(readFile(p));
    } catch {
      out[p] = null;
    }
  }
  return out;
}
