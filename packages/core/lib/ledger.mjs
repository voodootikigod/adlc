// Append-only JSONL ledgers under .adlc/ — the shared persistence layer for
// gate-manifest entries, prosecution findings, routing priors, etc.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` while holding an ownership-checked advisory lock on `${target}.lock`. */
export function withLedgerLock(target, fn, { retries = LOCK_MAX_RETRIES, delayMs = LOCK_RETRY_DELAY_MS } = {}) {
  const lockPath = `${target}.lock`;
  mkdirSync(dirname(target), { recursive: true });
  const owner = { version: 1, token: randomUUID(), pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
  for (let i = 0; i <= retries; i++) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx'); // fails if lock already held
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (i < retries) sleepSync(delayMs);
      continue;
    }
    try {
      writeFileSync(fd, `${JSON.stringify(owner)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      return fn();
    } finally {
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (current.token === owner.token) unlinkSync(lockPath);
      } catch {}
    }
  }
  throw new Error(`could not acquire ledger lock: ${lockPath} (held > ${retries * delayMs}ms)`);
}

function parseLedger(content) {
  const entries = [];
  const skipped = [];
  const rawLines = [];
  for (const [i, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    rawLines.push(line);
    try { entries.push(JSON.parse(line)); }
    catch (err) { skipped.push({ line: i + 1, error: String(err.message ?? err) }); }
  }
  return { entries, skipped, rawLines, lastRawLine: rawLines.at(-1) ?? null };
}

/**
 * Append a batch under one ledger lock. A factory is evaluated after the lock is
 * acquired and receives the byte-exact current ledger state, so callers can safely
 * allocate sequence numbers and hash-chain links without a read/append race.
 */
// ─── Tracked-ledger secret boundary ────────────────────────────────────────────
// `.adlc/findings.jsonl` is COMMITTED to git (ADR 0014), so every entry is published.
// "Curated prose, never raw dumps or secrets" must therefore be enforced, and enforced
// HERE — at the single write boundary every producer funnels through. Validating in one
// producer (recordFinding) left model-ratchet and gate-fuzzing writing unchecked, and
// scanning only `desc` left every other serialized field unchecked.
const FINDINGS_LEDGER = 'findings';
const MAX_FINDING_DESC = 600;
const SECRET_PATTERNS = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key block'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i, 'a bearer token'],
  [/\b(?:api[-_]?key|secret|passwd|password|token)\b\s*[:=]\s*\S{8,}/i, 'an inline credential assignment'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JWT'],
];

/**
 * Fail CLOSED on anything unfit for a committed ledger. Scans the WHOLE serialized
 * entry, not just `desc` — a secret pasted into any field is published just the same.
 */
export function assertPublishableFinding(entry) {
  const serialized = JSON.stringify(entry ?? null);
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`findings ledger: refusing to record — the entry appears to contain ${what}. This ledger is committed to git; describe the failure class instead of quoting the value (ADR 0014)`);
    }
  }
  const desc = typeof entry?.desc === 'string' ? entry.desc : '';
  if (/[\r\n]/.test(desc)) {
    throw new Error('findings ledger: desc must be a single line of curated prose — raw multi-line tool output is not recordable (ADR 0014)');
  }
  if (desc.length > MAX_FINDING_DESC) {
    throw new Error(`findings ledger: desc is ${desc.length} chars; curated descriptions are capped at ${MAX_FINDING_DESC} to keep dumps out of the committed ledger (ADR 0014)`);
  }
}

export function appendEntries(name, entriesOrFactory, dir = ADLC_DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = ledgerPath(name, dir);
  return withLedgerLock(p, () => {
    const content = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const state = parseLedger(content);
    const additions = typeof entriesOrFactory === 'function' ? entriesOrFactory(state) : entriesOrFactory;
    if (!Array.isArray(additions)) throw new TypeError('ledger append batch must be an array');
    if (additions.length === 0) return [];
    // Validate BEFORE any bytes are written, so a rejected entry leaves the ledger
    // untouched rather than half-appended.
    if (name === FINDINGS_LEDGER) for (const entry of additions) assertPublishableFinding(entry);
    const descriptor = openSync(p, 'a');
    try {
      writeFileSync(descriptor, additions.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(p), 'r');
      try { fsyncSync(directory); }
      finally { closeSync(directory); }
    }
    return additions;
  });
}

/** Append one entry (object) to the named ledger. Creates dir/file as needed. */
export function appendEntry(name, entry, dir = ADLC_DIR) {
  appendEntries(name, [entry], dir);
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
  const { entries, skipped } = parseLedger(readFileSync(p, 'utf8'));
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
