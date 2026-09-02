// build-gate-inline.mjs — self-contained build-gate backstop for adlc-gemini.
// Uses ONLY Node builtins (no npm @adlc/* runtime dependencies).

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, rmSync, lstatSync, unlinkSync, openSync, readSync, closeSync, appendFileSync, fstatSync, readdirSync, constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { loadTickets, globMatch, ticketStoreExists } from './core-inline.mjs';
import { loadTicketStoreReadOnly } from './generated-ticket-reader.mjs';
import { resolveActiveTicketId } from './rails-checker.mjs';
import { detectEditChurn, analyzeFlail, resolveTranscriptPath, parseTranscriptSteps } from './flail-inline.mjs';

export const DEFAULT_DEPTH_THRESHOLD = 50;
export const MAX_TRACKED_SESSIONS = 100;
export const LOCK_TTL_MS = 5000;
export const TRUST_ROOT_PATHS = ['.adlc/tickets.json', '.adlc/tickets/**', '.adlc/current-ticket.json', '.adlc/sessions.json', '.adlc/sessions.lock/**', '.adlc/session-ledger.jsonl', '.adlc/.session-secret'];
export const MANIFEST_PATH = '.adlc/manifest.jsonl';
export const HIGH_RISK_CATEGORIES = new Set(['contract', 'architecture']);

function touchesAny(globs, paths) {
  return (globs ?? []).some((g) => paths.some((p) => g === p || globMatch(g, p)));
}

function sleepSyncWithJitter(baseMs = 5) {
  const ms = baseMs + Math.floor(Math.random() * 5);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback */ }
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    return process.kill(pid, 0);
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

export const MAX_TRANSCRIPT_HASH_BYTES = 16 * 1024 * 1024;

export function computePrefixHash(filePath, targetBytes, maxBytes = MAX_TRANSCRIPT_HASH_BYTES) {
  if (typeof targetBytes !== 'number' || targetBytes <= 0) return null;
  const effectiveBytes = Math.min(targetBytes, maxBytes);
  let fd;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(Math.min(64 * 1024, effectiveBytes));
    let remaining = effectiveBytes;
    while (remaining > 0) {
      const toRead = Math.min(buf.length, remaining);
      const bytesRead = readSync(fd, buf, 0, toRead, null);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    return remaining === 0 ? hash.digest('hex') : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function readTranscriptPrefixBounded(filePath, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return {
      prefixHash: createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex'),
      prefixLength: bytesRead,
    };
  } catch {
    return { prefixHash: null, prefixLength: 0 };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function readTextFileBounded(filePath, maxBytes = 1024 * 1024) {
  let fd;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function deriveRiskSignals(ticket) {
  const t = ticket ?? {};
  const signals = [];
  if (t.risk === 'high') signals.push('declared-risk-high');
  if (t.external === true) signals.push('external-system-effect');
  if (t.mutatesIdentity === true) signals.push('mutates-identity');

  if (t.scope !== undefined && !Array.isArray(t.scope)) signals.push('malformed-scope');
  if (t.rails !== undefined && !Array.isArray(t.rails)) signals.push('malformed-rails');

  const combinedGlobs = [
    ...(Array.isArray(t.scope) ? t.scope : []),
    ...(Array.isArray(t.rails) ? t.rails : []),
  ];

  if (touchesAny(combinedGlobs, [MANIFEST_PATH])) signals.push('mutates-manifest');
  if (touchesAny(combinedGlobs, TRUST_ROOT_PATHS)) {
    signals.push('touches-trust-root');
    signals.push('touches-trust-roots');
  }
  if (t.category && HIGH_RISK_CATEGORIES.has(t.category)) signals.push(`high-risk-category:${t.category}`);

  return signals;
}

export function computeRiskTier(ticket) {
  if (!ticket || typeof ticket !== 'object') {
    return { tier: 'normal', signals: [] };
  }
  const signals = deriveRiskSignals(ticket);
  return { tier: signals.length > 0 ? 'high' : 'normal', signals };
}

export function createDepthTracker() {
  const counts = new Map();
  const compacted = new Set();
  return {
    recordToolCall(sessionID) {
      if (!sessionID) return;
      counts.set(sessionID, (counts.get(sessionID) ?? 0) + 1);
    },
    markCompacted(sessionID) {
      if (!sessionID) return;
      compacted.add(sessionID);
    },
    depth(sessionID) {
      return counts.get(sessionID) ?? 0;
    },
    isCompacted(sessionID) {
      return compacted.has(sessionID);
    },
    isLockFailed() {
      return false;
    },
  };
}

export function sanitizeSessionId(id) {
  if (typeof id !== 'string') return 'default_session';
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 120 || !/^[a-zA-Z0-9_\-\.]+$/.test(trimmed)) return 'default_session';
  if (trimmed === '__proto__' || trimmed === 'constructor' || trimmed === 'prototype' || trimmed === 'toString' || trimmed === 'valueOf') {
    return 'default_session';
  }
  return trimmed;
}

/**
 * Universal session ID resolution for hooks and status display.
 */
export function resolveSessionId({ payload, env = process.env } = {}) {
  const candidate = payload?.conversationId ?? payload?.conversation_id ?? payload?.conversationID ?? payload?.sessionID ?? payload?.sessionId ?? payload?.params?.conversationId ?? payload?.params?.conversation_id ?? env?.GEMINI_CONVERSATION_ID ?? env?.JETSKI_CONVERSATION_ID ?? env?.ANTIGRAVITY_CONVERSATION_ID ?? env?.CONVERSATION_ID ?? env?.ADLC_SESSION_ID;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return sanitizeSessionId(candidate);
  }
  return 'default_session';
}

const loadedSecretCache = new Map();

function getOrCreateSessionSecret(root, env = process.env) {
  if (env?.ADLC_SESSION_SECRET && env?.ADLC_P4_ENFORCEMENT !== '1') return env.ADLC_SESSION_SECRET;

  const userHome = homedir() || tmpdir();
  const adlcConfigDir = join(userHome, '.adlc');
  const masterKeyFile = join(adlcConfigDir, '.master-key');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  if (loadedSecretCache.has(root)) {
    return loadedSecretCache.get(root);
  }

  let masterKey = null;
  try {
    if (existsSync(masterKeyFile)) {
      const stat = lstatSync(masterKeyFile);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024) {
        if (uid === null || stat.uid === uid) {
          if ((stat.mode & 0o077) === 0) {
            const raw = readFileSync(masterKeyFile, 'utf8').trim();
            if (raw.length >= 32) masterKey = raw;
          }
        }
      }
    }
  } catch {}

  if (!masterKey) {
    try {
      if (!existsSync(adlcConfigDir)) {
        mkdirSync(adlcConfigDir, { recursive: true, mode: 0o700 });
      }
      const newKey = randomBytes(32).toString('hex');
      writeFileSync(masterKeyFile, newKey, { mode: 0o600, flag: 'wx' });
      masterKey = newKey;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stat = lstatSync(masterKeyFile);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024) {
            if (uid === null || stat.uid === uid) {
              if ((stat.mode & 0o077) === 0) {
                const raw = readFileSync(masterKeyFile, 'utf8').trim();
                if (raw.length >= 32) masterKey = raw;
              }
            }
          }
        } catch {}
      }
    }
  }

  if (!masterKey) return null;

  const derivedSecret = createHmac('sha256', masterKey)
    .update(`adlc-session-secret:${root}`)
    .digest('hex');

  loadedSecretCache.set(root, derivedSecret);
  return derivedSecret;
}

export function getTestFilesMap(root) {
  const map = {};
  if (!root || typeof root !== 'string') return map;
  try {
    for (const d of ['test', 'tests', 'spec', 'specs']) {
      const p = join(root, d);
      if (existsSync(p)) {
        try {
          const stat = lstatSync(p);
          if (stat.isDirectory()) {
            const entries = readdirSync(p, { recursive: true }).sort();
            for (const entry of entries) {
              const str = typeof entry === 'string' ? entry : entry?.name;
              if (str && (/\.(test|spec)\.(m?js|cjs|ts|tsx)$/i.test(str) || /^test-.*\.m?js$/i.test(str))) {
                const fullP = join(p, str);
                if (existsSync(fullP) && lstatSync(fullP).isFile()) {
                  const relPath = relative(root, fullP).replace(/\\/g, '/');
                  map[relPath] = createHash('sha256').update(readFileSync(fullP)).digest('hex');
                }
              }
            }
          }
        } catch {}
      }
    }
  } catch {}
  return map;
}

function computeBaselineSig(sessionID, s, root = process.cwd(), env = process.env) {
  const secretKey = getOrCreateSessionSecret(root, env);
  if (!secretKey) return null;
  const payload = JSON.stringify({
    sessionID,
    t: s?.initialActiveTicket ?? null,
    h: s?.initialStoreHash ?? null,
    p: s?.initialPointer ?? null,
    tr: s?.initialTranscript ?? null,
    tf: s?.initialTestFiles ?? null,
    depth: s?.depth ?? 0,
    totalCalls: s?.totalCalls ?? 0,
    mutatingCalls: s?.mutatingCalls ?? 0,
    compacted: Boolean(s?.compacted),
    ended: Boolean(s?.ended),
    edits: Array.isArray(s?.edits) ? s.edits : [],
    warned: Array.isArray(s?.warned) ? s.warned : [],
    flailStatus: s?.flailStatus ? { verdict: s.flailStatus.verdict ?? '', summary: s.flailStatus.summary ?? '' } : null,
    lastTranscriptSize: s?.lastTranscriptSize ?? null,
    lastTranscriptHash: s?.lastTranscriptHash ?? null,
    ledgerSeq: s?.ledgerSeq ?? 0,
    ledgerMac: s?.ledgerMac ?? null,
  });
  return createHmac('sha256', secretKey).update(payload).digest('hex');
}

const inMemorySessionSnapshots = new Map();

/**
 * File-backed persistent session tracker with owner-checked & PID-probed mutex locking and LRU pruning.
 * Reclaims orphaned lock directories even if owner.json is missing when mtime > 3s.
 * Writes owner.json atomically via temp file to prevent torn reads under contention.
 * Self-healing lock failures and nonce-gated lock release.
 */
export function createPersistentTracker(root = process.cwd(), env = process.env) {
  const adlcDir = join(root, '.adlc');
  const storePath = join(adlcDir, 'sessions.json');
  const ledgerPath = join(adlcDir, 'session-ledger.jsonl');
  const lockDir = join(adlcDir, 'sessions.lock');
  const ownerFile = join(lockDir, 'owner.json');

  const lockFailures = new Set();
  const snapKey = (sid) => `${root}:${sid}`;

  function withLock(sessionID, fn) {
    if (!ticketStoreExists(root, env)) return fn();
    try { mkdirSync(adlcDir, { recursive: true }); } catch {}
    const pid = process.pid;
    const nonce = `${pid}-${Date.now()}-${Math.random()}`;
    let acquired = false;

    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        mkdirSync(lockDir);
        const tmpOwner = `${lockDir}/owner.json.tmp.${pid}.${Date.now()}`;
        writeFileSync(tmpOwner, JSON.stringify({ pid, nonce, time: Date.now() }));
        renameSync(tmpOwner, ownerFile);
        acquired = true;
        break;
      } catch (err) {
        if (err.code === 'EEXIST') {
          try {
            let isStaleAndDead = false;
            if (existsSync(ownerFile)) {
              try {
                const raw = readFileSync(ownerFile, 'utf8');
                const owner = JSON.parse(raw);
                const isStale = Date.now() - (owner.time ?? 0) > 3000;
                const isDead = !isPidAlive(owner.pid);
                if (isStale && isDead) isStaleAndDead = true;
              } catch {
                // Malformed owner.json (crashed/partial write)
                const stat = lstatSync(lockDir);
                if (Date.now() - stat.mtimeMs > 3000) isStaleAndDead = true;
              }
            } else {
              const stat = lstatSync(lockDir);
              if (Date.now() - stat.mtimeMs > 3000) isStaleAndDead = true;
            }
            if (isStaleAndDead) {
              const tombstone = `${lockDir}.stale-${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              try {
                renameSync(lockDir, tombstone);
                rmSync(tombstone, { recursive: true, force: true });
              } catch {}
            }
          } catch {}
        }
      }
      sleepSyncWithJitter(10);
    }

    if (!acquired) {
      if (sessionID) lockFailures.add(sessionID);
      console.error(`[adlc-rails-guard] Warning: session store lock acquisition timed out`);
      return;
    }

    try {
      return fn();
    } finally {
      try {
        if (existsSync(ownerFile)) {
          const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
          if (owner.nonce === nonce) {
            const tombstone = `${lockDir}.rel-${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            renameSync(lockDir, tombstone);
            rmSync(tombstone, { recursive: true, force: true });
          }
        }
      } catch {}
    }
  }

  const MAX_LEDGER_BYTES = 512 * 1024; // 512 KiB write-side rotation threshold
  const HARD_MAX_LEDGER_BYTES = 2 * 1024 * 1024; // 2 MiB hard limit
  const MAX_LEDGER_RECORD_BYTES = 16 * 1024; // 16 KiB hard limit per individual record

  function computeLedgerMac(prevMac, seq, data) {
    const secret = getOrCreateSessionSecret(root, env);
    return createHmac('sha256', secret).update(`${prevMac}:${seq}:${JSON.stringify(data)}`).digest('hex');
  }

  function readLastLedgerHeader() {
    if (!existsSync(ledgerPath)) return { lastSeq: 0, lastMac: '0'.repeat(64) };
    let fd;
    try {
      fd = openSync(ledgerPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > HARD_MAX_LEDGER_BYTES) return null;
      if (stat.size === 0) return { lastSeq: 0, lastMac: '0'.repeat(64) };

      const readSize = Math.min(stat.size, 64 * 1024);
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, stat.size - readSize);
      const rawTail = buf.toString('utf8');
      const lines = rawTail.split('\n').filter(Boolean);
      if (lines.length === 0) return { lastSeq: 0, lastMac: '0'.repeat(64) };
      const last = JSON.parse(lines[lines.length - 1]);
      if (typeof last?.seq === 'number' && typeof last?.mac === 'string') {
        return { lastSeq: last.seq, lastMac: last.mac };
      }
    } catch {
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
    return null;
  }

  function appendLedger(entry) {
    if (!ticketStoreExists(root, env)) return null;
    try {
      if (!existsSync(adlcDir)) mkdirSync(adlcDir, { recursive: true });

      let header = readLastLedgerHeader();
      if (!header && existsSync(ledgerPath)) {
        // Unparseable ledger header or oversized file -> attempt replay, fail-closed if corrupted
        const replayed = replayLedger();
        if (replayed?._corrupted) {
          try {
            const lStat = lstatSync(ledgerPath);
            if (lStat.size > HARD_MAX_LEDGER_BYTES) {
              const tombstone = `${ledgerPath}.oversized-${Date.now()}`;
              renameSync(ledgerPath, tombstone);
              header = { lastSeq: 0, lastMac: '0'.repeat(64) };
            } else {
              return null;
            }
          } catch {
            return null;
          }
        } else {
          header = { lastSeq: 0, lastMac: '0'.repeat(64) };
        }
      }
      if (!header) header = { lastSeq: 0, lastMac: '0'.repeat(64) };

      const seq = header.lastSeq + 1;
      const prevMac = header.lastMac;
      const payload = { t: Date.now(), ...entry };
      const mac = computeLedgerMac(prevMac, seq, payload);
      const record = JSON.stringify({ seq, prevMac, mac, payload }) + '\n';

      // Enforce individual record size bound to prevent multi-megabyte writes
      if (Buffer.byteLength(record, 'utf8') > MAX_LEDGER_RECORD_BYTES) {
        return null;
      }

      // Check if ledger exceeds rotation threshold or hard limit
      if (existsSync(ledgerPath)) {
        try {
          const lStat = lstatSync(ledgerPath);
          if (lStat.isFile() && lStat.size + record.length > MAX_LEDGER_BYTES) {
            // Compact ledger: replay into compact state snapshot records
            const store = replayLedger();
            if (store && Object.keys(store).length > 0 && !store._corrupted) {
              const tmpLedger = `${ledgerPath}.tmp.${process.pid}.${Date.now()}`;
              const compactedLines = [];
              let curSeq = 0;
              let curPrevMac = '0'.repeat(64);
              for (const [sid, s] of Object.entries(store)) {
                if (sid === '_corrupted') continue;
                curSeq++;
                const snapPayload = {
                  t: s.updatedAt ?? Date.now(),
                  type: 'snapshot',
                  sessionID: sid,
                  depth: s.depth ?? 0,
                  totalCalls: s.totalCalls ?? 0,
                  mutatingCalls: s.mutatingCalls ?? 0,
                  compacted: Boolean(s.compacted),
                  ended: Boolean(s.ended),
                  edits: Array.isArray(s.edits) ? s.edits : [],
                  warned: Array.isArray(s.warned) ? s.warned : [],
                  initialActiveTicket: s.initialActiveTicket ?? null,
                  initialStoreHash: s.initialStoreHash ?? null,
                  initialPointer: s.initialPointer ?? null,
                  initialTranscript: s.initialTranscript ?? null,
                  lastTranscriptHash: s.lastTranscriptHash ?? null,
                  lastTranscriptSize: s.lastTranscriptSize ?? null,
                };
                const snapMac = computeLedgerMac(curPrevMac, curSeq, snapPayload);
                compactedLines.push(JSON.stringify({ seq: curSeq, prevMac: curPrevMac, mac: snapMac, payload: snapPayload }));
                curPrevMac = snapMac;
                s.ledgerSeq = curSeq;
                s.ledgerMac = snapMac;
                s.baselineSig = computeBaselineSig(sid, s, root, env);
              }
              curSeq++;
              const newEntryMac = computeLedgerMac(curPrevMac, curSeq, payload);
              compactedLines.push(JSON.stringify({ seq: curSeq, prevMac: curPrevMac, mac: newEntryMac, payload }));
              const fullCompacted = compactedLines.join('\n') + '\n';
              if (Buffer.byteLength(fullCompacted, 'utf8') <= HARD_MAX_LEDGER_BYTES) {
                writeFileSync(tmpLedger, fullCompacted, { mode: 0o600 });
                renameSync(tmpLedger, ledgerPath);
                if (entry.sessionID && store[entry.sessionID]) {
                  store[entry.sessionID].ledgerSeq = curSeq;
                  store[entry.sessionID].ledgerMac = newEntryMac;
                  store[entry.sessionID].baselineSig = computeBaselineSig(entry.sessionID, store[entry.sessionID], root, env);
                }
                writeStore(store, entry.sessionID);
                return { seq: curSeq, mac: newEntryMac };
              }
            }
            if (lStat.size > HARD_MAX_LEDGER_BYTES) {
              // Compaction failed and file exceeds hard limit -> quarantine oversized ledger
              const tombstone = `${ledgerPath}.oversized-${Date.now()}`;
              renameSync(ledgerPath, tombstone);
            }
          }
        } catch {}
      }

      // Final check: Never append if it would cause the ledger to exceed HARD_MAX_LEDGER_BYTES
      if (existsSync(ledgerPath)) {
        try {
          const lStat = lstatSync(ledgerPath);
          if (lStat.isFile() && lStat.size + Buffer.byteLength(record, 'utf8') > HARD_MAX_LEDGER_BYTES) {
            return null;
          }
        } catch {}
      }

      appendFileSync(ledgerPath, record, { mode: 0o600 });
      return { seq, mac };
    } catch {}
    return null;
  }

  function replayLedger() {
    let fd;
    try {
      if (!existsSync(ledgerPath)) return null;
      fd = openSync(ledgerPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.isFIFO && stat.isFIFO()) || (stat.isSocket && stat.isSocket()) || stat.size > HARD_MAX_LEDGER_BYTES) {
        const s = Object.create(null);
        s._corrupted = true;
        return s;
      }
      if (stat.size === 0) return null;
      const buf = Buffer.alloc(stat.size);
      readSync(fd, buf, 0, stat.size, 0);
      const raw = buf.toString('utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      const store = Object.create(null);
      let expectedSeq = 1;
      let expectedPrevMac = '0'.repeat(64);

      for (const line of lines) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          store._corrupted = true;
          return store;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          store._corrupted = true;
          return store;
        }

        // Authenticate ledger entry sequence and HMAC
        if (parsed.seq !== expectedSeq || parsed.prevMac !== expectedPrevMac) {
          store._corrupted = true;
          return store;
        }
        const expectedMac = computeLedgerMac(parsed.prevMac, parsed.seq, parsed.payload);
        if (parsed.mac !== expectedMac) {
          store._corrupted = true;
          return store;
        }
        expectedPrevMac = parsed.mac;
        expectedSeq = parsed.seq + 1;

        const ev = parsed.payload;
        if (!ev || typeof ev !== 'object') {
          store._corrupted = true;
          return store;
        }

        const safeKey = sanitizeSessionId(ev.sessionID);
        if (!safeKey) continue;
        const s = store[safeKey] ?? { depth: 0, totalCalls: 0, mutatingCalls: 0, compacted: false, edits: [], warned: [] };
        if (ev.type === 'snapshot') {
          s.depth = ev.depth ?? s.depth ?? 0;
          s.totalCalls = ev.totalCalls ?? s.totalCalls ?? 0;
          s.mutatingCalls = ev.mutatingCalls ?? s.mutatingCalls ?? 0;
          s.compacted = Boolean(ev.compacted);
          s.ended = Boolean(ev.ended);
          s.edits = Array.isArray(ev.edits) ? ev.edits : s.edits ?? [];
          s.warned = Array.isArray(ev.warned) ? ev.warned : s.warned ?? [];
          if (ev.initialActiveTicket) s.initialActiveTicket = ev.initialActiveTicket;
          if (ev.initialStoreHash) s.initialStoreHash = ev.initialStoreHash;
          if (ev.initialPointer) s.initialPointer = ev.initialPointer;
          if (ev.initialTranscript) s.initialTranscript = ev.initialTranscript;
          if (ev.lastTranscriptHash) s.lastTranscriptHash = ev.lastTranscriptHash;
          if (ev.lastTranscriptSize) s.lastTranscriptSize = ev.lastTranscriptSize;
        } else if (ev.type === 'recordActiveTicket' || ev.type === 'activeTicket') {
          if (!s.initialActiveTicket && (ev.activeTicketId || ev.ticketId)) {
            s.initialActiveTicket = ev.activeTicketId || ev.ticketId;
            s.initialStoreHash = ev.storeHash ?? null;
            if (ev.initialPointer || ev.pointer) s.initialPointer = ev.initialPointer || ev.pointer;
            if (ev.initialTestFiles) s.initialTestFiles = ev.initialTestFiles;
          }
        } else if (ev.type === 'recordToolCall' || ev.type === 'toolCall') {
          s.depth = (s.depth ?? 0) + 1;
          s.totalCalls = (s.totalCalls ?? 0) + 1;
          if (ev.isMutating) s.mutatingCalls = (s.mutatingCalls ?? 0) + 1;
        } else if (ev.type === 'revertToolCall') {
          if (s.depth > 0) s.depth -= 1;
          if (s.totalCalls > 0) s.totalCalls -= 1;
          if (ev.isMutating && s.mutatingCalls > 0) s.mutatingCalls -= 1;
        } else if (ev.type === 'recordEdit' || ev.type === 'edit') {
          if (ev.filePath) {
            const bp = typeof ev.filePath === 'string' && ev.filePath.length > 512 ? ev.filePath.slice(0, 512) : ev.filePath;
            s.edits.push(`Editing ${bp}`);
            if (s.edits.length > 200) s.edits = s.edits.slice(-200);
          }
        } else if (ev.type === 'compact') {
          s.compacted = true;
        } else if (ev.type === 'ended') {
          s.ended = true;
        } else if (ev.type === 'recordTranscript') {
          if (!s.initialTranscript && ev.initialTranscript) {
            s.initialTranscript = ev.initialTranscript;
          }
          if (ev.lastTranscriptHash) s.lastTranscriptHash = ev.lastTranscriptHash;
          if (ev.lastTranscriptSize) s.lastTranscriptSize = ev.lastTranscriptSize;
        } else if (ev.type === 'recordToolResult' || ev.type === 'toolResult') {
          if (ev.lastTranscriptHash) s.lastTranscriptHash = ev.lastTranscriptHash;
          if (ev.lastTranscriptSize) s.lastTranscriptSize = ev.lastTranscriptSize;
          if (typeof ev.exitCode === 'number') s.lastExitCode = ev.exitCode;
        }
        s.updatedAt = ev.t ?? Date.now();
        s.ledgerSeq = parsed.seq;
        s.ledgerMac = parsed.mac;
        s.baselineSig = computeBaselineSig(safeKey, s, root, env);
        store[safeKey] = s;
      }
      return store;
    } catch {
      const s = Object.create(null);
      s._corrupted = true;
      return s;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  function readStore() {
    let fd;
    try {
      if (existsSync(storePath)) {
        fd = openSync(storePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.isFIFO && stat.isFIFO()) || (stat.isSocket && stat.isSocket()) || stat.size > 1024 * 1024) {
          const s = Object.create(null);
          s._corrupted = true;
          return s;
        }
        const buf = Buffer.alloc(stat.size);
        readSync(fd, buf, 0, stat.size, 0);
        const raw = buf.toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          const s = Object.create(null);
          s._corrupted = true;
          return s;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const s = Object.create(null);
          s._corrupted = true;
          return s;
        }
        const store = Object.create(null);
        for (const [k, v] of Object.entries(parsed)) {
          const safeKey = sanitizeSessionId(k);
          if (safeKey && safeKey !== 'default_session') {
            store[safeKey] = v;
          } else if (k === 'default_session') {
            store.default_session = v;
          }
        }
        // TTL check for default_session (1 hour) to avoid stale lockouts across days
        if (store.default_session && store.default_session.updatedAt && Date.now() - store.default_session.updatedAt > 3600000) {
          delete store.default_session;
        }
        return store;
      } else {
        const fromLedger = replayLedger();
        if (fromLedger && Object.keys(fromLedger).length > 0) {
          return fromLedger;
        }
      }
    } catch (err) {
      console.error(`[adlc-rails-guard] Warning: failed to parse session store: ${err.message}`);
      const s = Object.create(null);
      s._corrupted = true;
      return s;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
    return Object.create(null);
  }

  function writeStore(data, currentSessionID) {
    if (!ticketStoreExists(root, env)) return;
    try {
      if (!existsSync(adlcDir)) mkdirSync(adlcDir, { recursive: true });

      const keys = Object.keys(data).filter((k) => k !== '_corrupted');
      for (const k of keys) {
        if (data[k] && typeof data[k] === 'object') {
          if (Array.isArray(data[k].edits)) {
            data[k].edits = data[k].edits
              .filter((e) => typeof e === 'string')
              .map((e) => (e.length > 512 ? e.slice(0, 512) : e))
              .slice(-200);
          }
          if (Array.isArray(data[k].warned)) {
            data[k].warned = data[k].warned
              .filter((w) => typeof w === 'string')
              .map((w) => (w.length > 256 ? w.slice(0, 256) : w))
              .slice(-20);
          }
          data[k].baselineSig = computeBaselineSig(k, data[k], root, env);
        }
      }

      if (keys.length > MAX_TRACKED_SESSIONS) {
        const sorted = keys.filter((k) => k !== currentSessionID).sort((a, b) => {
          const aEnded = Boolean(data[a]?.ended);
          const bEnded = Boolean(data[b]?.ended);
          if (aEnded !== bEnded) return aEnded ? -1 : 1;
          return (data[a]?.updatedAt ?? 0) - (data[b]?.updatedAt ?? 0);
        });
        const toRemove = sorted.slice(0, keys.length - MAX_TRACKED_SESSIONS);
        for (const k of toRemove) delete data[k];
      }

      let serialized = JSON.stringify(data, null, 2);
      if (serialized.length > 512 * 1024) {
        const sorted = keys.filter((k) => k !== currentSessionID).sort((a, b) => {
          const aEnded = Boolean(data[a]?.ended);
          const bEnded = Boolean(data[b]?.ended);
          if (aEnded !== bEnded) return aEnded ? -1 : 1;
          return (data[a]?.updatedAt ?? 0) - (data[b]?.updatedAt ?? 0);
        });
        for (const k of sorted) {
          delete data[k];
          serialized = JSON.stringify(data, null, 2);
          if (serialized.length <= 512 * 1024) break;
        }
      }

      const tmpPath = `${storePath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmpPath, serialized);
      renameSync(tmpPath, storePath);
    } catch (err) {
      console.error(`[adlc-rails-guard] Warning: failed to write session store: ${err.message}`);
    }
  }

  return {
    rawStore() {
      return readStore();
    },
    recordToolCall(sessionID, { isMutating = true } = {}) {
      if (!sessionID || !ticketStoreExists(root, env)) return;
      withLock(sessionID, () => {
        const store = readStore();
        if (store._corrupted && env?.ADLC_P4_ENFORCEMENT === '1') {
          return; // Fail closed: do not reset or accept new calls on corrupted store
        }
        const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [] };
        const snap = inMemorySessionSnapshots.get(snapKey(sessionID));
        if (snap) {
          s.depth = Math.max(s.depth ?? 0, snap.depth ?? 0);
          s.totalCalls = Math.max(s.totalCalls ?? 0, snap.totalCalls ?? 0);
          s.mutatingCalls = Math.max(s.mutatingCalls ?? 0, snap.mutatingCalls ?? 0);
          if (snap.compacted) s.compacted = true;
          if (snap.initialActiveTicket && !s.initialActiveTicket) s.initialActiveTicket = snap.initialActiveTicket;
        }
        s.depth = (s.depth ?? 0) + 1;
        s.totalCalls = (s.totalCalls ?? 0) + 1;
        s.mutatingCalls = (s.mutatingCalls ?? 0) + (isMutating ? 1 : 0);
        const lH = appendLedger({ type: 'recordToolCall', sessionID, isMutating, depth: s.depth, totalCalls: s.totalCalls, mutatingCalls: s.mutatingCalls });
        const curStore = readStore();
        const curS = curStore[sessionID] ?? s;
        if (lH) {
          curS.ledgerSeq = lH.seq;
          curS.ledgerMac = lH.mac;
        }
        curS.depth = s.depth;
        curS.totalCalls = s.totalCalls;
        curS.mutatingCalls = s.mutatingCalls;
        curS.updatedAt = Date.now();
        curS.baselineSig = computeBaselineSig(sessionID, curS, root, env);
        curStore[sessionID] = curS;
        inMemorySessionSnapshots.set(snapKey(sessionID), { ...curS });
        writeStore(curStore, sessionID);
      });
    },
    revertToolCall(sessionID, { isMutating = true } = {}) {
      if (!sessionID || !ticketStoreExists(root, env)) return;
      withLock(sessionID, () => {
        const store = readStore();
        const s = store[sessionID];
        if (!s) return;
        if (s.depth && s.depth > 0) s.depth -= 1;
        if (s.totalCalls && s.totalCalls > 0) s.totalCalls -= 1;
        if (isMutating && s.mutatingCalls && s.mutatingCalls > 0) s.mutatingCalls -= 1;
        const lH = appendLedger({ type: 'revertToolCall', sessionID, isMutating, depth: s.depth, totalCalls: s.totalCalls, mutatingCalls: s.mutatingCalls });
        const curStore = readStore();
        const curS = curStore[sessionID] ?? s;
        if (lH) {
          curS.ledgerSeq = lH.seq;
          curS.ledgerMac = lH.mac;
        }
        curS.depth = s.depth;
        curS.totalCalls = s.totalCalls;
        curS.mutatingCalls = s.mutatingCalls;
        curS.updatedAt = Date.now();
        curS.baselineSig = computeBaselineSig(sessionID, curS, root, env);
        curStore[sessionID] = curS;
        inMemorySessionSnapshots.set(snapKey(sessionID), { ...curS });
        writeStore(curStore, sessionID);
      });
    },
    totalCalls(sessionID) {
      if (!sessionID) return 0;
      const store = readStore();
      return store[sessionID]?.totalCalls ?? inMemorySessionSnapshots.get(snapKey(sessionID))?.totalCalls ?? 0;
    },
    mutatingCalls(sessionID) {
      if (!sessionID) return 0;
      const store = readStore();
      return store[sessionID]?.mutatingCalls ?? store[sessionID]?.depth ?? inMemorySessionSnapshots.get(snapKey(sessionID))?.mutatingCalls ?? 0;
    },
    recordActiveTicket(sessionID, activeTicketId, storeHash) {
      if (!sessionID || !ticketStoreExists(root, env)) return;
      withLock(sessionID, () => {
        const store = readStore();
        const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [] };
        let pointerInfo = null;
        if (!s.initialActiveTicket && activeTicketId) {
          s.initialActiveTicket = activeTicketId;
          s.initialStoreHash = storeHash ?? null;
          s.initialTestFiles = getTestFilesMap(root);
          const currentFile = join(root, '.adlc', 'current-ticket.json');
          if (existsSync(currentFile)) {
            try {
              const cStat = lstatSync(currentFile);
              pointerInfo = { exists: true, ino: cStat.ino, dev: cStat.dev, size: cStat.size };
              s.initialPointer = pointerInfo;
            } catch {}
          }
        }
        const lH = appendLedger({ type: 'recordActiveTicket', sessionID, activeTicketId, storeHash, initialPointer: pointerInfo, initialTestFiles: s.initialTestFiles });
        const curStore = readStore();
        const curS = curStore[sessionID] ?? s;
        if (lH) {
          curS.ledgerSeq = lH.seq;
          curS.ledgerMac = lH.mac;
        }
        if (s.initialActiveTicket) curS.initialActiveTicket = s.initialActiveTicket;
        if (s.initialStoreHash) curS.initialStoreHash = s.initialStoreHash;
        if (s.initialPointer) curS.initialPointer = s.initialPointer;
        if (s.initialTestFiles) curS.initialTestFiles = s.initialTestFiles;
        curS.updatedAt = Date.now();
        curS.baselineSig = computeBaselineSig(sessionID, curS, root, env);
        curStore[sessionID] = curS;
        inMemorySessionSnapshots.set(snapKey(sessionID), { ...curS });
        writeStore(curStore, sessionID);
      });
    },
    initialTicket(sessionID) {
      if (!sessionID) return null;
      const store = readStore();
      return store[sessionID]?.initialActiveTicket ?? inMemorySessionSnapshots.get(snapKey(sessionID))?.initialActiveTicket ?? null;
    },
    initialStoreHash(sessionID) {
      if (!sessionID) return null;
      const store = readStore();
      return store[sessionID]?.initialStoreHash ?? inMemorySessionSnapshots.get(snapKey(sessionID))?.initialStoreHash ?? null;
    },
    initialPointer(sessionID) {
      if (!sessionID) return null;
      const store = readStore();
      return store[sessionID]?.initialPointer ?? null;
    },
    initialTestFiles(sessionID) {
      if (!sessionID) return null;
      const store = readStore();
      return store[sessionID]?.initialTestFiles ?? inMemorySessionSnapshots.get(snapKey(sessionID))?.initialTestFiles ?? null;
    },
    hasSnapshot(sessionID) {
      if (!sessionID) return false;
      return inMemorySessionSnapshots.has(snapKey(sessionID));
    },
    validateBaseline(sessionID) {
      if (!sessionID) return true;
      const store = readStore();
      if (store._corrupted && env?.ADLC_P4_ENFORCEMENT === '1') {
        return false;
      }
      const snap = inMemorySessionSnapshots.get(snapKey(sessionID));
      const s = store[sessionID];
      if (snap) {
        if (!s || !existsSync(storePath)) return false; // Deleted/wiped session store or evicted
        if ((s.depth ?? 0) < (snap.depth ?? 0) || (s.mutatingCalls ?? 0) < (snap.mutatingCalls ?? 0) || (s.totalCalls ?? 0) < (snap.totalCalls ?? 0)) {
          return false; // Counters artificially lowered
        }
        if (snap.compacted && !s.compacted) return false;
      }
      if (!s) return true;
      const hasTrackedState = (s.totalCalls ?? 0) > 0 || (s.depth ?? 0) > 0 || (s.mutatingCalls ?? 0) > 0 || Boolean(s.initialActiveTicket) || Boolean(s.initialTranscript);
      if (!s.baselineSig) {
        return !hasTrackedState && env?.ADLC_P4_ENFORCEMENT !== '1';
      }
      const expected = computeBaselineSig(sessionID, s, root, env);
      if (!expected) return false;
      return s.baselineSig === expected;
    },
    markSessionEnded(sessionID) {
      if (!sessionID || !ticketStoreExists(root, env)) return;
      withLock(sessionID, () => {
        const store = readStore();
        const s = store[sessionID];
        if (!s) return;
        s.ended = true;
        const lH = appendLedger({ type: 'ended', sessionID });
        const curStore = readStore();
        const curS = curStore[sessionID] ?? s;
        if (lH) {
          curS.ledgerSeq = lH.seq;
          curS.ledgerMac = lH.mac;
        }
        curS.ended = true;
        curS.updatedAt = Date.now();
        curS.baselineSig = computeBaselineSig(sessionID, curS, root, env);
        curStore[sessionID] = curS;
        inMemorySessionSnapshots.set(snapKey(sessionID), { ...curS });
        writeStore(curStore, sessionID);
      });
    },
    recordTranscript(sessionID, transcriptPath) {
      if (!sessionID || !ticketStoreExists(root, env) || !transcriptPath) return;
      try {
        const stat = lstatSync(transcriptPath);
        withLock(sessionID, () => {
          const store = readStore();
          const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [] };
          let initialTranscript = s.initialTranscript ?? null;
          if (!s.initialTranscript) {
            const curHash = computePrefixHash(transcriptPath, stat.size);
            const boundedPath = transcriptPath.length > 512 ? transcriptPath.slice(0, 512) : transcriptPath;
            initialTranscript = { path: boundedPath, ino: stat.ino, dev: stat.dev, hash: curHash, size: stat.size };
            s.initialTranscript = initialTranscript;
          }
          const curHash = computePrefixHash(transcriptPath, stat.size);
          if (curHash) s.lastTranscriptHash = curHash;
          s.lastTranscriptSize = stat.size;
          const lH = appendLedger({ type: 'recordTranscript', sessionID, initialTranscript, lastTranscriptHash: s.lastTranscriptHash, lastTranscriptSize: s.lastTranscriptSize });
          const curStore = readStore();
          const curS = curStore[sessionID] ?? s;
          if (lH) {
            curS.ledgerSeq = lH.seq;
            curS.ledgerMac = lH.mac;
          }
          if (s.initialTranscript) curS.initialTranscript = s.initialTranscript;
          if (s.lastTranscriptHash) curS.lastTranscriptHash = s.lastTranscriptHash;
          if (s.lastTranscriptSize) curS.lastTranscriptSize = s.lastTranscriptSize;
          curS.updatedAt = Date.now();
          curS.baselineSig = computeBaselineSig(sessionID, curS, root, env);
          curStore[sessionID] = curS;
          writeStore(curStore, sessionID);
        });
      } catch {}
    },
    initialTranscript(sessionID) {
      if (!sessionID) return null;
      const store = readStore();
      return store[sessionID]?.initialTranscript ?? null;
    },
    lastTranscript(sessionID) {
      if (!sessionID) return null;
      const store = readStore();
      const s = store[sessionID];
      if (!s) return null;
      return {
        initial: s.initialTranscript ?? null,
        lastHash: s.lastTranscriptHash ?? null,
        lastSize: s.lastTranscriptSize ?? null,
      };
    },
    recordToolResult(sessionID, { exitCode, transcriptPath } = {}) {
      if (!sessionID || !ticketStoreExists(root, env)) return;
      try {
        let stat = null;
        if (transcriptPath) {
          try { stat = lstatSync(transcriptPath); } catch {}
        }
        withLock(sessionID, () => {
          const store = readStore();
          const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [] };
          if (stat && stat.size > 0) {
            const curHash = computePrefixHash(transcriptPath, stat.size);
            if (curHash) s.lastTranscriptHash = curHash;
            s.lastTranscriptSize = stat.size;
          }
          if (typeof exitCode === 'number') {
            s.lastExitCode = exitCode;
          }
          const lH = appendLedger({
            type: 'recordToolResult',
            sessionID,
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            lastTranscriptHash: s.lastTranscriptHash ?? null,
            lastTranscriptSize: s.lastTranscriptSize ?? null,
          });
          const curStore = readStore();
          const curS = curStore[sessionID] ?? s;
          if (lH) {
            curS.ledgerSeq = lH.seq;
            curS.ledgerMac = lH.mac;
          }
          if (s.lastTranscriptHash) curS.lastTranscriptHash = s.lastTranscriptHash;
          if (s.lastTranscriptSize) curS.lastTranscriptSize = s.lastTranscriptSize;
          if (typeof s.lastExitCode === 'number') curS.lastExitCode = s.lastExitCode;
          curS.updatedAt = Date.now();
          curS.baselineSig = computeBaselineSig(sessionID, curS, root, env);
          curStore[sessionID] = curS;
          writeStore(curStore, sessionID);
        });
      } catch {}
    },
    markCompacted(sessionID) {
      if (!sessionID || !ticketStoreExists(root, env)) return;
      withLock(sessionID, () => {
        const store = readStore();
        const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [] };
        s.compacted = true;
        const lH = appendLedger({ type: 'compact', sessionID });
        const curStore = readStore();
        const curS = curStore[sessionID] ?? s;
        if (lH) {
          curS.ledgerSeq = lH.seq;
          curS.ledgerMac = lH.mac;
        }
        curS.compacted = true;
        curS.updatedAt = Date.now();
        curS.baselineSig = computeBaselineSig(sessionID, curS, root, env);
        curStore[sessionID] = curS;
        writeStore(curStore, sessionID);
      });
    },
    recordEdit(sessionID, filePath, { transcriptSteps = [], transcriptLines = [] } = {}) {
      if (!sessionID || !ticketStoreExists(root, env)) return { churning: [], repeatedErrors: [], verdict: 'clean', summary: '' };
      return withLock(sessionID, () => {
        const store = readStore();
        const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [], warned: [] };
        s.edits = s.edits ?? [];
        s.warned = s.warned ?? [];
        const boundedPath = typeof filePath === 'string' ? (filePath.length > 512 ? filePath.slice(0, 512) : filePath) : null;
        if (boundedPath) {
          s.edits.push(`Editing ${boundedPath}`);
          if (s.edits.length > 200) s.edits = s.edits.slice(-200);
        }

        const analysis = analyzeFlail({ edits: s.edits, transcriptSteps, transcriptLines });
        const hashKey = `${analysis.verdict}:${analysis.summary}`;
        const isNew = analysis.verdict === 'flail' && !s.warned.includes(hashKey);
        if (isNew) {
          s.warned.push(hashKey);
        }

        s.flailStatus = {
          verdict: analysis.verdict,
          summary: analysis.summary,
          updatedAt: Date.now(),
        };

        const lH = appendLedger({ type: 'recordEdit', sessionID, filePath: boundedPath });
        const curStore = readStore();
        const curS = curStore[sessionID] ?? s;
        if (lH) {
          curS.ledgerSeq = lH.seq;
          curS.ledgerMac = lH.mac;
        }
        curS.edits = s.edits;
        curS.warned = s.warned;
        curS.flailStatus = s.flailStatus;
        curS.updatedAt = Date.now();
        curS.baselineSig = computeBaselineSig(sessionID, curS, root, env);
        curStore[sessionID] = curS;
        writeStore(curStore, sessionID);

        const churns = detectEditChurn(s.edits, 3);
        const newlyChurning = churns.filter((c) => !s.warned.includes(c.path));
        for (const c of newlyChurning) s.warned.push(c.path);

        return {
          churning: newlyChurning,
          verdict: analysis.verdict,
          signals: analysis.signals,
          summary: analysis.summary,
          recommendation: analysis.recommendation,
          isNewSignal: isNew,
        };
      }, { churning: [], verdict: 'clean', summary: '' });
    },
    edits(sessionID) {
      if (!sessionID) return [];
      const store = readStore();
      return store[sessionID]?.edits ?? [];
    },
    depth(sessionID) {
      if (!sessionID) return 0;
      const store = readStore();
      return store[sessionID]?.depth ?? 0;
    },
    isCompacted(sessionID) {
      if (!sessionID) return false;
      const store = readStore();
      return Boolean(store[sessionID]?.compacted);
    },
    isLockFailed(sessionID) {
      if (!sessionID) return false;
      return lockFailures.has(sessionID);
    },
    isCorrupted() {
      const store = readStore();
      return Boolean(store._corrupted);
    },
    validateLedger(sessionID) {
      if (!ticketStoreExists(root, env)) return true;
      if (!existsSync(ledgerPath)) {
        if (existsSync(storePath)) {
          const store = readStore();
          if (store._corrupted) return false;
          const entry = sessionID ? store[sessionID] : null;
          if (entry && (entry.ledgerSeq > 0 || entry.depth > 0 || entry.totalCalls > 0)) {
            return false;
          }
        }
        return true;
      }
      const replayed = replayLedger();
      if (!replayed || replayed._corrupted) return false;
      if (sessionID) {
        const store = readStore();
        if (store._corrupted) return false;
        const entry = store[sessionID];
        if (entry && typeof entry.ledgerSeq === 'number' && entry.ledgerSeq > 0) {
          const replayedEntry = replayed[sessionID];
          if (
            !replayedEntry ||
            replayedEntry.ledgerSeq !== entry.ledgerSeq ||
            (replayedEntry.depth ?? 0) !== (entry.depth ?? 0) ||
            (replayedEntry.totalCalls ?? 0) !== (entry.totalCalls ?? 0) ||
            (replayedEntry.mutatingCalls ?? 0) !== (entry.mutatingCalls ?? 0)
          ) {
            return false;
          }
        }
      }
      return true;
    },
  };
}

export function checkFlail({ sessionID, tracker, root = process.cwd(), env = process.env }) {
  if (!sessionID || sessionID === 'default_session') {
    return { verdict: 'clean', signals: [], summary: '', recommendation: 'Session clean' };
  }
  const transcriptPath = resolveTranscriptPath({ conversationId: sessionID, env });
  const transcriptSteps = transcriptPath ? parseTranscriptSteps(transcriptPath) : [];
  const storeEdits = tracker?.edits?.(sessionID) ?? [];
  return analyzeFlail({ edits: storeEdits, transcriptSteps });
}

export function decideBuildGate({ riskTier, degraded, bypass, sessionID } = {}) {
  if (riskTier !== 'high') {
    return { decision: 'allow', reason: `ticket risk tier is '${riskTier ?? 'normal'}' — gate only guards high-risk tickets` };
  }
  if (!degraded) {
    return { decision: 'allow', reason: 'high-risk ticket, but context-fitness is not degraded' };
  }
  if (bypass) {
    return { decision: 'allow', reason: 'high-risk build in a degraded session, but ADLC_BUILD_GATE_BYPASS=1 was set', overridden: true };
  }
  if (sessionID === 'default_session') {
    return {
      decision: 'deny',
      reason: 'high-risk ticket build denied: context depth threshold exceeded in a session with unresolvable session ID (default_session). Delete .adlc/sessions.json or set ADLC_BUILD_GATE_BYPASS=1.',
    };
  }
  return {
    decision: 'deny',
    reason: 'high-risk ticket build denied: context depth threshold exceeded in this session. Resume in a fresh session before continuing.',
  };
}

export function checkBuildGate({ sessionID, tracker, root = process.cwd(), env = process.env }) {
  if (env.ADLC_P4_ENFORCEMENT !== '1') {
    return { decision: 'allow', reason: 'enforcement inactive' };
  }
  if (tracker?.isCorrupted?.()) {
    return { decision: 'deny', reason: 'Session tracking store is corrupted or unreadable under enforcement (fail closed).' };
  }
  const override = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null;
  const ticketsPath = override ? (isAbsolute(override) ? override : join(root, override)) : join(root, '.adlc', 'tickets.json');
  if (!ticketStoreExists(root, env)) {
    return { decision: 'allow', reason: 'repo not ADLC-initialized' };
  }
  const active = resolveActiveTicketId(root, env);
  if (active.conflict) {
    return { decision: 'deny', reason: 'ticket pointer conflict between ADLC_TICKET env and .adlc/current-ticket.json' };
  }
  if (!active.id) {
    return { decision: 'allow', reason: 'no unambiguous active ticket' };
  }
  let ticket = null;
  try {
    const store = loadTicketStoreReadOnly({ root, env });
    ticket = store.get(active.id);
  } catch (err) {
    return { decision: 'deny', reason: `corrupt or unparseable ticket store: ${err?.message ?? err}` };
  }
  if (!ticket) {
    return { decision: 'deny', reason: `active ticket ${active.id} declared in current-ticket.json but not found in tickets.json` };
  }

  if (tracker?.validateBaseline && !tracker.validateBaseline(sessionID)) {
    return { decision: 'deny', reason: 'Session baseline signature mismatch (tampering detected).' };
  }
  if (tracker?.validateLedger && !tracker.validateLedger(sessionID)) {
    return { decision: 'deny', reason: 'Session ledger integrity verification failed (tampering or truncation detected).' };
  }

  const { tier } = computeRiskTier(ticket);
  const depth = tracker?.depth?.(sessionID) ?? 0;
  const parsedThreshold = Number.parseInt(env.ADLC_BUILD_GATE_DEPTH_THRESHOLD ?? '', 10);
  const depthThreshold = Number.isNaN(parsedThreshold) ? DEFAULT_DEPTH_THRESHOLD : parsedThreshold;
  const degraded = depth >= depthThreshold || Boolean(tracker?.isCompacted?.(sessionID)) || Boolean(tracker?.isLockFailed?.(sessionID));

  const verdict = decideBuildGate({
    riskTier: tier,
    degraded,
    bypass: env.ADLC_BUILD_GATE_BYPASS === '1',
    sessionID,
  });

  if (verdict.decision === 'deny') {
    const cause = tracker?.isLockFailed?.(sessionID) ? 'session lock acquisition timed out (fail closed)' : tracker?.isCompacted?.(sessionID) ? 'session was compacted' : `tool-call depth ${depth} >= ${depthThreshold}`;
    return { ...verdict, reason: `${verdict.reason} [signal: ${cause}]` };
  }
  return verdict;
}
