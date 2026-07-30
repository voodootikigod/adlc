import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { conflict } from './errors.mjs';
import { sha256 } from './canonical.mjs';
import { fsyncDirectory } from './durability.mjs';
import { validateKeyParam } from './key-contract.mjs';

const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

export function withManifestLock(path, fn, { retries = 400, delayMs = 5 } = {}) {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const owner = { version: 1, token: randomUUID(), pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let descriptor;
    try { descriptor = openSync(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt < retries) sleep(delayMs);
      continue;
    }
    try {
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    try { return fn(); }
    finally {
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (current.token === owner.token) unlinkSync(lockPath);
      } catch {}
    }
  }
  throw conflict('MANIFEST_LOCK_TIMEOUT', `could not acquire manifest lock: ${lockPath}`);
}

function lastLine(content) {
  return content.split('\n').reverse().find((line) => line.trim()) ?? null;
}

function sign(key, entry) {
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== undefined) canonical.ticket = entry.ticket;
  canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return createHmac('sha256', key).update(JSON.stringify(canonical)).digest('hex');
}

/** Append an idempotent, hash-bound transaction/recovery record to gate-manifest. */
export function recordTicketEvidence(root, {
  key,
  transactionId,
  operation,
  action = 'apply',
  ticketId = null,
  ticketHash = null,
  storeHash,
  archiveHash = null,
  revision = process.env.ADLC_REVISION ?? null,
} = {}) {
  // Validate FIRST: the idempotent-retry early return must not bypass the key
  // contract — an invalid key is a caller bug on every path, retries included.
  const signingKey = validateKeyParam(key);
  const path = join(root, '.adlc/manifest.jsonl');
  return withManifestLock(path, () => {
    const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const lines = content.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.data?.transactionId === transactionId && entry.data?.action === action) {
          const matches = entry.gate === `ticket-${operation}`
            && (entry.ticket ?? null) === ticketId
            && entry.data.operation === operation
            && (entry.data.ticketHash ?? null) === ticketHash
            && entry.data.storeHash === storeHash
            && (entry.data.archiveHash ?? null) === archiveHash
            && entry.data.bindingScope === (ticketId ? 'ticket' : 'store');
          if (!matches) throw conflict('EVIDENCE_IDEMPOTENCY_CONFLICT', `transaction ${transactionId}/${action} already has different evidence`);
          return entry;
        }
      } catch (error) {
        if (error?.code === 'EVIDENCE_IDEMPOTENCY_CONFLICT') throw error;
        throw conflict('INVALID_MANIFEST', 'cannot append ticket evidence to a malformed manifest');
      }
    }
    const previous = lastLine(content);
    const prior = previous ? JSON.parse(previous) : null;
    const data = {
      operation,
      action,
      transactionId,
      revision,
      ticketHash,
      storeHash,
      ...(archiveHash ? { archiveHash } : {}),
      bindingScope: ticketId ? 'ticket' : 'store',
    };
    const entry = {
      seq: typeof prior?.seq === 'number' ? prior.seq + 1 : 1,
      gate: `ticket-${operation}`,
      ts: new Date().toISOString(),
      ...(ticketId ? { ticket: ticketId } : {}),
      data,
      files: {},
      prev: previous ? sha256(previous) : null,
    };
    if (signingKey) entry.sig = sign(signingKey, entry);
    const descriptor = openSync(path, 'a');
    try {
      writeFileSync(descriptor, `${JSON.stringify(entry)}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    fsyncDirectory(dirname(path));
    return entry;
  });
}
