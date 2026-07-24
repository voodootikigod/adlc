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
// The ledger is committed + append-only, so a raw dump smuggled into ANY field — not just
// `desc` — permanently bloats git history. These bound the WHOLE entry: a curated finding is
// small and near-single-line; a transcript / diff hunk / stack trace / log paste is neither.
// Generous relative to a real finding (desc alone is capped at 600) but far below a dump.
const MAX_FINDING_ENTRY = 4000; // total serialized entry bytes
const MAX_FINDING_LINES = 10;   // total newlines across all (nested) string values

// Count literal newlines across every string in the entry, recursing into nested
// objects/arrays. Counting the RAW values (not the JSON-escaped `\n` in the serialized
// form) avoids miscounting an escaped backslash that precedes an 'n' in a path.
function countEntryNewlines(value) {
  if (typeof value === 'string') return (value.match(/[\r\n]/g) || []).length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + countEntryNewlines(v), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((n, v) => n + countEntryNewlines(v), 0);
  return 0;
}
// KNOWN provider credential shapes. This list is necessarily incomplete — new formats
// appear constantly — so it is a best-effort filter, NOT a proof of secret-freedom.
// The high-entropy catch below covers unlabelled random secrets the list misses, and
// the durable guarantee remains that findings are CURATED PROSE (ADR 0014), not a
// claim that this function catches every possible secret.
const SECRET_PATTERNS = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bASIA[0-9A-Z]{16}\b/, 'an AWS temporary access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, 'a GitHub fine-grained token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, 'a GitLab token'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, 'an OpenAI API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key block'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i, 'a bearer token'],
  [/\b(?:api[-_]?key|secret|passwd|password|token|access[-_]?key)\b\s*[:=]\s*\S{8,}/i, 'an inline credential assignment'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JWT'],
];

// Shannon entropy (bits/char) of a token — high for random secrets, low for prose.
function tokenEntropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) { const p = n / s.length; bits -= p * Math.log2(p); }
  return bits;
}

// A long, high-entropy, mixed-case+digit run with no whitespace is almost certainly a
// key/token, not curated prose. Deliberately conservative — hex-only runs (git shas,
// hashes findings legitimately cite) are EXEMPT, so this does not fire on the ledger's
// own member keys or on quoted commit ids.
function looksLikeRandomSecret(text) {
  for (const token of String(text).split(/[\s"'`(){}\[\],:]+/)) {
    if (token.length < 32) continue;
    // Pure hex up to a git-sha's 40 chars is exempt (a sha, a member key, a cluster
    // id — things findings legitimately cite). A LONGER pure-hex run is NOT a git sha;
    // treat it as a hex-encoded key or hash that belongs described, not quoted — the
    // exact 64-char-hex-in-`evidence` bypass an unbounded hex exemption allowed.
    if (/^[0-9a-f]{1,40}$/i.test(token)) continue;
    if (/^[0-9a-f]{41,}$/i.test(token)) return true;
    if (!/[a-z]/.test(token) || !/[A-Z0-9]/.test(token)) continue; // needs real mixing
    if (tokenEntropy(token) >= 4.0) return true;
  }
  return false;
}

/**
 * Fail CLOSED on anything unfit for a committed ledger. Both boundaries — the secret scan
 * AND the raw-dump size/line bounds — apply to the WHOLE serialized entry, not just `desc`:
 * a secret or a multi-line dump pasted into any field is committed just the same.
 */
export function assertPublishableFinding(entry) {
  // A committed ledger entry must be a USABLE finding, not just secret-free. A bare
  // `null`, scalar, or array is syntactically valid JSON that passes a secret scan but
  // crashes the P7 pipeline: loadFindings dereferences `.verdict` and clusters on
  // `.desc`. Reject anything that is not a finding object with a clustering key, so the
  // git-boundary scan cannot approve a ledger that breaks lesson-foundry.
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('findings ledger: entry must be a finding object (a non-null, non-array object) — a bare null/scalar/array crashes the distillation pipeline (ADR 0014)');
  }
  if (typeof entry.desc !== 'string' || entry.desc.trim().length === 0) {
    throw new Error('findings ledger: entry must carry a non-empty string `desc` (the clustering key) — an entry without it starves lesson-foundry (ADR 0014)');
  }
  const serialized = JSON.stringify(entry);
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`findings ledger: refusing to record — the entry appears to contain ${what}. This ledger is committed to git; describe the failure class instead of quoting the value (ADR 0014)`);
    }
  }
  if (looksLikeRandomSecret(serialized)) {
    throw new Error('findings ledger: refusing to record — the entry contains a long, high-entropy token that looks like a key or secret. This ledger is committed to git; describe the failure class instead of quoting the value (ADR 0014)');
  }
  const desc = typeof entry?.desc === 'string' ? entry.desc : '';
  if (/[\r\n]/.test(desc)) {
    throw new Error('findings ledger: desc must be a single line of curated prose — raw multi-line tool output is not recordable (ADR 0014)');
  }
  if (desc.length > MAX_FINDING_DESC) {
    throw new Error(`findings ledger: desc is ${desc.length} chars; curated descriptions are capped at ${MAX_FINDING_DESC} to keep dumps out of the committed ledger (ADR 0014)`);
  }

  // desc-only bounds above are not enough: a raw dump can be smuggled into evidence, body,
  // exploit_scenario, or any other field, and (unlike a credential) a plain multi-line log
  // paste matches no secret pattern and its whitespace defeats the high-entropy token scan.
  // Bound the WHOLE entry so no field escapes (adversarial-review distillation round-12).
  if (serialized.length > MAX_FINDING_ENTRY) {
    throw new Error(`findings ledger: entry is ${serialized.length} bytes serialized; curated findings are capped at ${MAX_FINDING_ENTRY} to keep raw dumps out of the committed, append-only ledger (ADR 0014)`);
  }
  const newlines = countEntryNewlines(entry);
  if (newlines > MAX_FINDING_LINES) {
    throw new Error(`findings ledger: entry spans ${newlines} lines across its fields; a curated finding is near-single-line, so this looks like a raw multi-line dump (transcript, diff hunk, stack trace, log paste) — describe the failure class instead (ADR 0014)`);
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
