// session-tracker.mjs — persistent HMAC session tracker, stale-lock reclamation,
// secret management, build-gate/flail checks, and scope-aware test verification.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, rmSync, lstatSync,
  unlinkSync, openSync, readSync, writeSync, closeSync, fstatSync, readdirSync, realpathSync, constants as fsConstants,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { globMatch } from '@adlc/core';
import { detectTicketStore } from '@adlc/tickets';
import { resolveActiveTicketId } from './pretool.mjs';
import { detectEditChurn, analyzeFlail, resolveTranscriptPath, parseTranscriptSteps, parseTranscriptRecords } from './flail-transcript.mjs';
import { isShellTool, classifyTool, extractCommandString, TRUST_ROOT_RAILS, resolveUserHome } from './command-verify.mjs';

export { resolveUserHome };
export const DEFAULT_DEPTH_THRESHOLD = 50;
export const MAX_TRACKED_SESSIONS = 100;
export const LOCK_TTL_MS = 5000;
export const TRUST_ROOT_PATHS = ['.adlc/tickets.json', '.adlc/tickets/**', '.adlc/current-ticket.json', '.adlc/sessions.json', '.adlc/sessions.lock/**', '.adlc/session-ledger.jsonl', '.adlc/.session-secret', '.booster/**'];
export const MANIFEST_PATH = '.adlc/manifest.jsonl';
export const HIGH_RISK_CATEGORIES = new Set(['contract', 'architecture']);
export const MAX_TRANSCRIPT_HASH_BYTES = 16 * 1024 * 1024;

const HARD_MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_LEDGER_RECORD_BYTES = 16 * 1024;
const ZERO_MAC = '0'.repeat(64);
const loadedSecretCache = new Map();
const inMemorySessionSnapshots = new Map();

function ticketStoreExists(root, env = process.env) {
  if (!root || typeof root !== 'string') return false;
  const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  if (ov && typeof ov === 'string' && ov.trim() && existsSync(isAbsolute(ov.trim()) ? ov.trim() : join(root, ov.trim()))) return true;
  return existsSync(join(root, '.adlc', 'tickets.json')) || existsSync(join(root, '.adlc', 'tickets', '.store.json'));
}
const loadStoreSnapshot = (root, env = process.env) => detectTicketStore({ root, ticketStore: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || undefined, allowRecovery: true, env }).load();
function sleepSyncWithJitter(baseMs = 5) {
  const ms = baseMs + Math.floor(Math.random() * 5);
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) {} }
}
const isPidAlive = (pid) => { if (!pid || typeof pid !== 'number') return false; try { return process.kill(pid, 0); } catch (err) { return err.code !== 'ESRCH'; } };

export function computePrefixHash(filePath, targetBytes, maxBytes = MAX_TRANSCRIPT_HASH_BYTES) {
  if (typeof targetBytes !== 'number' || targetBytes <= 0) return null;
  let rem = Math.min(targetBytes, maxBytes); let fd;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const hash = createHash('sha256'); const buf = Buffer.allocUnsafe(Math.min(64 * 1024, rem));
    while (rem > 0) { const n = readSync(fd, buf, 0, Math.min(buf.length, rem), null); if (n <= 0) break; hash.update(buf.subarray(0, n)); rem -= n; }
    return rem === 0 ? hash.digest('hex') : null;
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}
export function readTranscriptPrefixBounded(filePath, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const buf = Buffer.allocUnsafe(maxBytes); const n = readSync(fd, buf, 0, maxBytes, 0);
    return { prefixHash: createHash('sha256').update(buf.subarray(0, n)).digest('hex'), prefixLength: n };
  } catch { return { prefixHash: null, prefixLength: 0 }; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}
export function readTextFileBounded(filePath, maxBytes = 1024 * 1024) {
  let fd;
  try { fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK); const buf = Buffer.allocUnsafe(maxBytes); return buf.toString('utf8', 0, readSync(fd, buf, 0, maxBytes, 0)); }
  catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

const touchesAny = (globs, paths) => (globs ?? []).some((g) => paths.some((p) => g === p || globMatch(g, p)));
export function deriveRiskSignals(ticket) {
  const t = ticket ?? {}; const s = [];
  if (t.risk === 'high') s.push('declared-risk-high');
  if (t.external === true) s.push('external-system-effect');
  if (t.mutatesIdentity === true) s.push('mutates-identity');
  if (t.scope !== undefined && !Array.isArray(t.scope)) s.push('malformed-scope');
  if (t.rails !== undefined && !Array.isArray(t.rails)) s.push('malformed-rails');
  const all = [...(Array.isArray(t.scope) ? t.scope : []), ...(Array.isArray(t.rails) ? t.rails : [])];
  if (touchesAny(all, [MANIFEST_PATH])) s.push('mutates-manifest');
  if (touchesAny(all, TRUST_ROOT_PATHS)) s.push('touches-trust-root', 'touches-trust-roots');
  if (t.category && HIGH_RISK_CATEGORIES.has(t.category)) s.push(`high-risk-category:${t.category}`);
  return s;
}
export function computeRiskTier(ticket) {
  if (!ticket || typeof ticket !== 'object') return { tier: 'normal', signals: [] };
  const signals = deriveRiskSignals(ticket);
  return { tier: signals.length > 0 ? 'high' : 'normal', signals };
}
export function createDepthTracker() {
  const c = new Map(); const comp = new Set();
  return { recordToolCall: (s) => s && c.set(s, (c.get(s) ?? 0) + 1), markCompacted: (s) => s && comp.add(s), depth: (s) => c.get(s) ?? 0, isCompacted: (s) => comp.has(s), isLockFailed: () => false };
}
export function sanitizeSessionId(id) {
  if (typeof id !== 'string') return 'default_session';
  const t = id.trim();
  return (!t || t.length > 120 || !/^[a-zA-Z0-9_\-.]+$/.test(t) || ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf'].includes(t)) ? 'default_session' : t;
}
export function resolveSessionId({ payload, env = process.env } = {}) {
  const c = payload?.conversationId ?? payload?.conversation_id ?? payload?.conversationID ?? payload?.sessionID ?? payload?.sessionId ?? payload?.params?.conversationId ?? payload?.params?.conversation_id ?? env?.GEMINI_CONVERSATION_ID ?? env?.JETSKI_CONVERSATION_ID ?? env?.ANTIGRAVITY_CONVERSATION_ID ?? env?.CONVERSATION_ID ?? env?.ADLC_SESSION_ID;
  return typeof c === 'string' && c.trim() ? sanitizeSessionId(c) : 'default_session';
}

function readValidKeyFile(p, uid) {
  if (!existsSync(p)) return null;
  const st = lstatSync(p);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 || (uid !== null && st.uid !== uid) || (st.mode & 0o077) !== 0) return null;
  const raw = readFileSync(p, 'utf8').trim();
  return raw.length >= 32 ? raw : null;
}
export function getMasterKeyRaw(env = process.env) {
  const h = resolveUserHome(env); const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  try { return readValidKeyFile(join(h, '.config', 'adlc', 'secrets', '.auth-key'), uid) ?? readValidKeyFile(join(h, '.adlc', '.master-key'), uid); } catch { return null; }
}
export function rotateMasterKey(env = process.env) {
  const h = resolveUserHome(env); const dir = join(h, '.config', 'adlc', 'secrets'); const file = join(dir, '.auth-key');
  try { const l = join(h, '.adlc', '.master-key'); if (existsSync(l)) unlinkSync(l); } catch {}
  loadedSecretCache.clear();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const nk = randomBytes(32).toString('hex'); const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, nk, { mode: 0o600 }); renameSync(tmp, file); return nk;
  } catch { return null; }
}
export function getOrCreateSessionSecret(root, env = process.env) {
  const h = resolveUserHome(env); const key = `${h}:${root}`;
  if (loadedSecretCache.has(key)) return loadedSecretCache.get(key);
  let mk = getMasterKeyRaw(env);
  if (!mk) {
    const dir = join(h, '.config', 'adlc', 'secrets'); const file = join(dir, '.auth-key');
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }); const nk = randomBytes(32).toString('hex'); writeFileSync(file, nk, { mode: 0o600, flag: 'wx' }); mk = nk; }
    catch (err) { if (err.code === 'EEXIST') mk = getMasterKeyRaw(env); }
  }
  if (!mk) return null;
  const derived = createHmac('sha256', mk).update(`adlc-session-secret:${root}`).digest('hex');
  loadedSecretCache.set(key, derived); return derived;
}

export function isNodeTestFile(fileName, relPath) {
  if (!fileName || typeof fileName !== 'string' || !/\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/i.test(fileName)) return false;
  if (relPath.replace(/\\/g, '/').split('/').some((p) => /^(tests?|specs?|__tests?__|__specs?__)$/i.test(p))) return true;
  return /\.(test|spec)\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/i.test(fileName) || /^test-.*|.*[-_]test\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/i.test(fileName) || /^test\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/i.test(fileName);
}
export function getTestFilesMap(root) {
  const map = {}; if (!root || typeof root !== 'string') return map;
  let realRoot = root; try { realRoot = realpathSync(root); } catch {}
  const IGNORED = new Set(['node_modules', '.git', '.worktrees', 'dist', 'build', '.adlc', 'coverage', '.cache']);
  function scan(dir, depth = 0, anc = new Set()) {
    if (depth > 32) return;
    let real; try { real = realpathSync(dir); const r = relative(realRoot, real); if (r.startsWith('..') || isAbsolute(r) || anc.has(real)) return; } catch { return; }
    const next = new Set(anc); next.add(real);
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = join(dir, e.name);
      try {
        if (lstatSync(fp).isSymbolicLink()) { const r = relative(realRoot, realpathSync(fp)); if (r.startsWith('..') || isAbsolute(r)) continue; }
        const st = statSync(fp);
        if (st.isDirectory()) { if (!IGNORED.has(e.name)) scan(fp, depth + 1, next); }
        else if (st.isFile()) { const rp = relative(root, fp).replace(/\\/g, '/'); if (isNodeTestFile(e.name, rp)) map[rp] = createHash('sha256').update(readFileSync(fp)).digest('hex'); }
      } catch {}
    }
  }
  scan(root); return map;
}
export function hasDiscoverableTests(root, filterDir = null) {
  const keys = Object.keys(getTestFilesMap(root));
  if (!filterDir) return keys.length > 0;
  const rel = relative(root, filterDir).replace(/\\/g, '/');
  return keys.some((k) => k === rel || k.startsWith(rel + '/'));
}
export function verifyPreExistingTestFiles(root, initialTestFiles, ticket = null) {
  if (!initialTestFiles || typeof initialTestFiles !== 'object' || !Object.keys(initialTestFiles).length) return { ok: true, reason: null, file: null };
  const current = getTestFilesMap(root);
  const scope = Array.isArray(ticket?.scope) ? ticket.scope.filter((s) => typeof s === 'string' && s.trim()) : [];
  const rails = [...(Array.isArray(ticket?.rails) ? ticket.rails.filter((r) => typeof r === 'string' && r.trim()) : []), ...TRUST_ROOT_RAILS];
  const matches = (list, p) => list.some((g) => g === p || globMatch(g, p));
  for (const [relPath, origHash] of Object.entries(initialTestFiles)) {
    const inRail = matches(rails, relPath); const inScope = scope.length > 0 && matches(scope, relPath);
    if (!current[relPath]) return { ok: false, file: relPath, reason: `ADLC Rails-Guard: Pre-existing test file "${relPath}" was deleted or renamed.` };
    if (current[relPath] !== origHash && !(inScope && !inRail)) {
      return { ok: false, file: relPath, reason: `ADLC Rails-Guard: Pre-existing test file "${relPath}" was modified during session${inRail ? ' (protected by frozen rails)' : ' (outside active ticket scope)'}, weakening the verification suite.` };
    }
  }
  return { ok: true, reason: null, file: null };
}

const lockStat = (d) => { try { const st = lstatSync(d); return { ino: st.ino, mtimeMs: st.mtimeMs }; } catch { return null; } };
const readOwnerRaw = (d) => { try { return readFileSync(join(d, 'owner.json'), 'utf8'); } catch { return null; } };
export function judgeStaleLock(lockDir, now = Date.now()) {
  const stat = lockStat(lockDir); if (stat === null) return null;
  const ownerRaw = readOwnerRaw(lockDir); let owner = null;
  try { owner = ownerRaw === null ? null : JSON.parse(ownerRaw); } catch { owner = null; }
  return (owner && typeof owner === 'object' ? (now - (owner.time ?? 0) > LOCK_TTL_MS && !isPidAlive(owner.pid)) : (now - stat.mtimeMs > LOCK_TTL_MS)) ? { ownerRaw, stat } : null;
}
export function reclaimJudgedLock(lockDir, judged) {
  const claimed = `${lockDir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try { renameSync(lockDir, claimed); } catch { return false; }
  const ownerRaw = readOwnerRaw(claimed); const now = ownerRaw === null ? lockStat(claimed) : null;
  if (!(ownerRaw === judged.ownerRaw && (ownerRaw !== null || Boolean(now && judged.stat && now.ino === judged.stat.ino && now.mtimeMs === judged.stat.mtimeMs)))) { try { renameSync(claimed, lockDir); } catch {} return false; }
  try { rmSync(claimed, { recursive: true, force: true }); } catch {} return true;
}
function computeBaselineSig(sessionID, s, root, env) {
  const k = getOrCreateSessionSecret(root, env); if (!k) return null;
  return createHmac('sha256', k).update(JSON.stringify({ sessionID, t: s?.initialActiveTicket ?? null, h: s?.initialStoreHash ?? null, p: s?.initialPointer ?? null, tr: s?.initialTranscript ?? null, tf: s?.initialTestFiles ?? null, depth: s?.depth ?? 0, totalCalls: s?.totalCalls ?? 0, mutatingCalls: s?.mutatingCalls ?? 0, compacted: Boolean(s?.compacted), ended: Boolean(s?.ended), inv: Boolean(s?.invalidated), edits: Array.isArray(s?.edits) ? s.edits : [], warned: Array.isArray(s?.warned) ? s.warned : [], flailStatus: s?.flailStatus ? { verdict: s.flailStatus.verdict ?? '', summary: s.flailStatus.summary ?? '' } : null, lastTranscriptSize: s?.lastTranscriptSize ?? null, lastTranscriptHash: s?.lastTranscriptHash ?? null, lastExitCode: typeof s?.lastExitCode === 'number' ? s.lastExitCode : null, ledgerSeq: s?.ledgerSeq ?? 0, ledgerMac: s?.ledgerMac ?? null })).digest('hex');
}
function openVerifiedRegular(filePath, maxBytes) {
  const ls = lstatSync(filePath); if (ls.isSymbolicLink() || !ls.isFile() || ls.size > maxBytes) return null;
  const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
  try { const st = fstatSync(fd); if (!st.isFile() || st.ino !== ls.ino || st.dev !== ls.dev || st.size > maxBytes) { closeSync(fd); return null; } return { fd, size: st.size }; }
  catch { try { closeSync(fd); } catch {} return null; }
}

export function createPersistentTracker(root = process.cwd(), env = process.env) {
  const adlcDir = join(root, '.adlc'); const storePath = join(adlcDir, 'sessions.json');
  const ledgerPath = join(adlcDir, 'session-ledger.jsonl'); const lockDir = join(adlcDir, 'sessions.lock');
  const ownerFile = join(lockDir, 'owner.json'); const lockFailures = new Set();
  const snapKey = (sid) => `${root}:${sid}`; const corruptStore = () => Object.assign(Object.create(null), { _corrupted: true });
  const macOf = (prev, seq, data) => createHmac('sha256', getOrCreateSessionSecret(root, env)).update(`${prev}:${seq}:${JSON.stringify(data)}`).digest('hex');

  function withLock(sid, fn, fallback) {
    if (!ticketStoreExists(root, env)) return fn();
    try { mkdirSync(adlcDir, { recursive: true }); } catch {}
    const nonce = `${process.pid}-${Date.now()}-${Math.random()}`; let acq = false;
    for (let i = 0; i < 250; i++) {
      try { mkdirSync(lockDir); const tmp = `${lockDir}/owner.json.tmp.${process.pid}.${Date.now()}`; writeFileSync(tmp, JSON.stringify({ pid: process.pid, nonce, time: Date.now() })); renameSync(tmp, ownerFile); acq = true; break; }
      catch (err) { if (err.code === 'EEXIST') { const j = judgeStaleLock(lockDir); if (j) reclaimJudgedLock(lockDir, j); } }
      sleepSyncWithJitter(25);
    }
    if (!acq) { if (sid) lockFailures.add(sid); return fallback; }
    try { return fn(); } finally {
      try { if (existsSync(ownerFile) && JSON.parse(readFileSync(ownerFile, 'utf8')).nonce === nonce) { const t = `${lockDir}.rel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`; renameSync(lockDir, t); rmSync(t, { recursive: true, force: true }); } } catch {}
    }
  }
  function replayLedger() {
    if (!existsSync(ledgerPath)) return null; let op;
    try {
      op = openVerifiedRegular(ledgerPath, HARD_MAX_LEDGER_BYTES); if (!op) return corruptStore(); if (!op.size) return null;
      const buf = Buffer.alloc(op.size); readSync(op.fd, buf, 0, op.size, 0);
      const store = Object.create(null); let seq = 1; let prev = ZERO_MAC;
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        const p = JSON.parse(line);
        if (!p || typeof p !== 'object' || Array.isArray(p) || p.seq !== seq || p.prevMac !== prev || p.mac !== macOf(p.prevMac, p.seq, p.payload) || !p.payload || typeof p.payload !== 'object') return corruptStore();
        prev = p.mac; seq = p.seq + 1; const ev = p.payload; const sk = sanitizeSessionId(ev.sessionID);
        const s = store[sk] ?? { depth: 0, totalCalls: 0, mutatingCalls: 0, compacted: false, edits: [], warned: [] };
        if (ev.type === 'snapshot') Object.assign(s, ev);
        else if (ev.type === 'recordActiveTicket' || ev.type === 'activeTicket') { if (!s.initialActiveTicket && (ev.activeTicketId || ev.ticketId)) { s.initialActiveTicket = ev.activeTicketId || ev.ticketId; s.initialStoreHash = ev.storeHash ?? null; if (ev.initialPointer) s.initialPointer = ev.initialPointer; if (ev.initialTestFiles) s.initialTestFiles = ev.initialTestFiles; } }
        else if (ev.type === 'recordToolCall' || ev.type === 'toolCall') { s.depth++; s.totalCalls++; if (ev.isMutating) s.mutatingCalls++; }
        else if (ev.type === 'revertToolCall') { if (s.depth > 0) s.depth--; if (s.totalCalls > 0) s.totalCalls--; if (ev.isMutating && s.mutatingCalls > 0) s.mutatingCalls--; }
        else if (ev.type === 'recordEdit' || ev.type === 'edit') { if (ev.filePath) s.edits = [...s.edits, `Editing ${String(ev.filePath).slice(0, 512)}`].slice(-200); }
        else if (ev.type === 'compact') s.compacted = true;
        else if (ev.type === 'ended') s.ended = true;
        else if (ev.type === 'invalidated') s.invalidated = true;
        else if (ev.type === 'recordTranscript' || ev.type === 'recordToolResult' || ev.type === 'toolResult') { if (!s.initialTranscript && ev.initialTranscript) s.initialTranscript = ev.initialTranscript; if (ev.lastTranscriptHash) s.lastTranscriptHash = ev.lastTranscriptHash; if (ev.lastTranscriptSize) s.lastTranscriptSize = ev.lastTranscriptSize; if (typeof ev.exitCode === 'number') s.lastExitCode = ev.exitCode; }
        s.updatedAt = ev.t ?? Date.now(); s.ledgerSeq = p.seq; s.ledgerMac = p.mac; s.baselineSig = computeBaselineSig(sk, s, root, env); store[sk] = s;
      }
      return store;
    } catch { return corruptStore(); } finally { if (op) try { closeSync(op.fd); } catch {} }
  }
  function appendLedger(entry) {
    if (!ticketStoreExists(root, env)) return null;
    try {
      if (!existsSync(adlcDir)) mkdirSync(adlcDir, { recursive: true });
      let lastSeq = 0; let lastMac = ZERO_MAC;
      if (existsSync(ledgerPath)) {
        const op = openVerifiedRegular(ledgerPath, HARD_MAX_LEDGER_BYTES); if (!op) return null;
        try { if (op.size > 0) { const rs = Math.min(op.size, 64 * 1024); const buf = Buffer.alloc(rs); readSync(op.fd, buf, 0, rs, op.size - rs); const lines = buf.toString('utf8').split('\n').filter(Boolean); const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null; if (last && typeof last.seq === 'number' && typeof last.mac === 'string') { lastSeq = last.seq; lastMac = last.mac; } } }
        finally { try { closeSync(op.fd); } catch {} }
      }
      const seq = lastSeq + 1; const payload = { t: Date.now(), ...entry }; const mac = macOf(lastMac, seq, payload);
      const record = JSON.stringify({ seq, prevMac: lastMac, mac, payload }) + '\n';
      if (Buffer.byteLength(record, 'utf8') > MAX_LEDGER_RECORD_BYTES) return null;
      const fd = openSync(ledgerPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      try { writeSync(fd, record); } finally { try { closeSync(fd); } catch {} }
      return { seq, mac };
    } catch { return null; }
  }
  function readStore() {
    if (!existsSync(storePath)) { const f = replayLedger(); return f && Object.keys(f).length ? f : Object.create(null); }
    let op;
    try {
      op = openVerifiedRegular(storePath, 1024 * 1024); if (!op) return corruptStore();
      const buf = Buffer.alloc(op.size); readSync(op.fd, buf, 0, op.size, 0); const parsed = JSON.parse(buf.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed._corrupted) return corruptStore();
      const store = Object.create(null);
      for (const [k, v] of Object.entries(parsed)) { const sk = sanitizeSessionId(k); if (k === 'default_session' || (sk && sk !== 'default_session')) store[k === 'default_session' ? 'default_session' : sk] = v; }
      if (store.default_session?.updatedAt && Date.now() - store.default_session.updatedAt > 3600000) delete store.default_session;
      return store;
    } catch { return corruptStore(); } finally { if (op) try { closeSync(op.fd); } catch {} }
  }
  function writeStore(data, curSid) {
    if (!ticketStoreExists(root, env)) return;
    try {
      if (!existsSync(adlcDir)) mkdirSync(adlcDir, { recursive: true });
      const keys = Object.keys(data).filter((k) => k !== '_corrupted');
      for (const k of keys) if (data[k] && typeof data[k] === 'object') data[k].baselineSig = computeBaselineSig(k, data[k], root, env);
      if (keys.length > MAX_TRACKED_SESSIONS) {
        const sorted = keys.filter((k) => k !== curSid).sort((a, b) => (Boolean(data[a]?.ended) === Boolean(data[b]?.ended) ? (data[a]?.updatedAt ?? 0) - (data[b]?.updatedAt ?? 0) : data[a]?.ended ? -1 : 1));
        for (const k of sorted.slice(0, keys.length - MAX_TRACKED_SESSIONS)) delete data[k];
      }
      if (existsSync(storePath) && lstatSync(storePath).isSymbolicLink()) return;
      const tmp = `${storePath}.tmp.${process.pid}.${Date.now()}`; writeFileSync(tmp, JSON.stringify(data, null, 2)); renameSync(tmp, storePath);
    } catch {}
  }
  function mutate(sid, fn, fallback) {
    if (!sid || !ticketStoreExists(root, env)) return fallback;
    return withLock(sid, () => {
      const store = readStore(); if (store._corrupted && env?.ADLC_P4_ENFORCEMENT === '1') return fallback;
      const s = store[sid] ?? { depth: 0, totalCalls: 0, mutatingCalls: 0, compacted: false, edits: [], warned: [] };
      const res = fn(s, store); if (res?.skip) return res.value;
      const lH = res?.ledger ? appendLedger({ sessionID: sid, ...res.ledger }) : null;
      if (lH) { s.ledgerSeq = lH.seq; s.ledgerMac = lH.mac; }
      s.updatedAt = Date.now(); s.baselineSig = computeBaselineSig(sid, s, root, env);
      store[sid] = s; inMemorySessionSnapshots.set(snapKey(sid), { ...s }); writeStore(store, sid);
      return res?.value;
    }, fallback);
  }
  const get = (sid, field, def = null) => (sid ? (readStore()[sid]?.[field] ?? inMemorySessionSnapshots.get(snapKey(sid))?.[field] ?? def) : def);
  return {
    rawStore: readStore,
    recordToolCall: (sid, { isMutating = true } = {}) => mutate(sid, (s) => { const sn = inMemorySessionSnapshots.get(snapKey(sid)); if (sn) { s.depth = Math.max(s.depth ?? 0, sn.depth ?? 0); s.totalCalls = Math.max(s.totalCalls ?? 0, sn.totalCalls ?? 0); s.mutatingCalls = Math.max(s.mutatingCalls ?? 0, sn.mutatingCalls ?? 0); } s.depth++; s.totalCalls++; if (isMutating) s.mutatingCalls++; return { ledger: { type: 'recordToolCall', isMutating, depth: s.depth, totalCalls: s.totalCalls, mutatingCalls: s.mutatingCalls } }; }),
    revertToolCall: (sid, { isMutating = true } = {}) => mutate(sid, (s, st) => (!st[sid] ? { skip: true } : (s.depth > 0 && s.depth--, s.totalCalls > 0 && s.totalCalls--, isMutating && s.mutatingCalls > 0 && s.mutatingCalls--, { ledger: { type: 'revertToolCall', isMutating, depth: s.depth, totalCalls: s.totalCalls, mutatingCalls: s.mutatingCalls } }))),
    recordActiveTicket: (sid, activeTicketId, storeHash) => mutate(sid, (s) => { let ptr = null; if (!s.initialActiveTicket && activeTicketId) { s.initialActiveTicket = activeTicketId; s.initialStoreHash = storeHash ?? null; s.initialTestFiles = getTestFilesMap(root); const cf = join(root, '.adlc', 'current-ticket.json'); if (existsSync(cf)) try { const st = lstatSync(cf); ptr = { exists: true, ino: st.ino, dev: st.dev, size: st.size }; s.initialPointer = ptr; } catch {} } return { ledger: { type: 'recordActiveTicket', activeTicketId, storeHash, initialPointer: ptr, initialTestFiles: s.initialTestFiles } }; }),
    recordTranscript(sid, tp) { if (!tp) return; try { const st = lstatSync(tp); mutate(sid, (s) => { const h = computePrefixHash(tp, st.size); if (!s.initialTranscript) s.initialTranscript = { path: tp.slice(0, 512), ino: st.ino, dev: st.dev, hash: h, size: st.size }; if (h) s.lastTranscriptHash = h; s.lastTranscriptSize = st.size; return { ledger: { type: 'recordTranscript', initialTranscript: s.initialTranscript, lastTranscriptHash: s.lastTranscriptHash, lastTranscriptSize: s.lastTranscriptSize } }; }); } catch {} },
    recordToolResult(sid, { exitCode, transcriptPath } = {}) { let st = null; if (transcriptPath) try { st = lstatSync(transcriptPath); } catch {} mutate(sid, (s) => { if (st && st.size > 0) { const h = computePrefixHash(transcriptPath, st.size); if (h) s.lastTranscriptHash = h; s.lastTranscriptSize = st.size; } if (typeof exitCode === 'number') s.lastExitCode = exitCode; return { ledger: { type: 'recordToolResult', exitCode: typeof exitCode === 'number' ? exitCode : null, lastTranscriptHash: s.lastTranscriptHash ?? null, lastTranscriptSize: s.lastTranscriptSize ?? null } }; }); },
    markCompacted: (sid) => mutate(sid, (s) => { s.compacted = true; return { ledger: { type: 'compact' } }; }),
    markSessionEnded: (sid) => mutate(sid, (s, st) => (!st[sid] ? { skip: true } : (s.ended = true, { ledger: { type: 'ended' } }))),
    invalidateSession: (sid) => mutate(sid, (s) => { s.invalidated = true; return { ledger: { type: 'invalidated', reason: 'secret_disclosure' } }; }),
    recordEdit: (sid, fp, { transcriptSteps = [], transcriptLines = [] } = {}) => mutate(sid, (s) => { s.edits = s.edits ?? []; s.warned = s.warned ?? []; const bp = typeof fp === 'string' ? fp.slice(0, 512) : null; if (bp) s.edits = [...s.edits, `Editing ${bp}`].slice(-200); const a = analyzeFlail({ edits: s.edits, transcriptSteps, transcriptLines }); const hk = `${a.verdict}:${a.summary}`; const isNew = a.verdict === 'flail' && !s.warned.includes(hk); if (isNew) s.warned.push(hk); s.flailStatus = { verdict: a.verdict, summary: a.summary, updatedAt: Date.now() }; const ch = detectEditChurn(s.edits, 3).filter((c) => !s.warned.includes(c.path)); for (const c of ch) s.warned.push(c.path); return { ledger: { type: 'recordEdit', filePath: bp }, value: { churning: ch, verdict: a.verdict, signals: a.signals, summary: a.summary, recommendation: a.recommendation, isNewSignal: isNew } }; }, { churning: [], repeatedErrors: [], verdict: 'clean', summary: '' }),
    totalCalls: (sid) => get(sid, 'totalCalls', 0),
    mutatingCalls: (sid) => (sid ? (readStore()[sid]?.mutatingCalls ?? readStore()[sid]?.depth ?? inMemorySessionSnapshots.get(snapKey(sid))?.mutatingCalls ?? 0) : 0),
    depth: (sid) => (sid ? (readStore()[sid]?.depth ?? 0) : 0),
    edits: (sid) => (sid ? (readStore()[sid]?.edits ?? []) : []),
    isCompacted: (sid) => Boolean(sid && readStore()[sid]?.compacted),
    isLockFailed: (sid) => Boolean(sid && lockFailures.has(sid)),
    initialTicket: (sid) => get(sid, 'initialActiveTicket', null),
    initialStoreHash: (sid) => get(sid, 'initialStoreHash', null),
    initialPointer: (sid) => (sid ? (readStore()[sid]?.initialPointer ?? null) : null),
    initialTestFiles: (sid) => get(sid, 'initialTestFiles', null),
    initialTranscript: (sid) => (sid ? (readStore()[sid]?.initialTranscript ?? null) : null),
    lastTranscript: (sid) => { const s = sid ? readStore()[sid] : null; return s ? { initial: s.initialTranscript ?? null, lastHash: s.lastTranscriptHash ?? null, lastSize: s.lastTranscriptSize ?? null } : null; },
    hasSnapshot: (sid) => Boolean(sid && inMemorySessionSnapshots.has(snapKey(sid))),
    isCorrupted: () => existsSync(join(adlcDir, '.ledger-quarantine')) || Boolean(readStore()._corrupted),
    isInvalidated: (sid) => Boolean(sid && (existsSync(join(adlcDir, '.ledger-quarantine')) || readStore()[sid]?.invalidated || inMemorySessionSnapshots.get(snapKey(sid))?.invalidated || replayLedger()?.[sid]?.invalidated)),
    validateBaseline(sid) {
      if (!sid) return true; const store = readStore(); if (store._corrupted && env?.ADLC_P4_ENFORCEMENT === '1') return false;
      const sn = inMemorySessionSnapshots.get(snapKey(sid)); const s = store[sid];
      if (sn && (!s || !existsSync(storePath) || s.invalidated || sn.invalidated || (s.depth ?? 0) < (sn.depth ?? 0) || (s.mutatingCalls ?? 0) < (sn.mutatingCalls ?? 0) || (s.totalCalls ?? 0) < (sn.totalCalls ?? 0) || (sn.compacted && !s.compacted))) return false;
      if (!s) { const l = replayLedger()?.[sid]; return !(l && ((l.mutatingCalls ?? 0) > 0 || (l.totalCalls ?? 0) > 0)); }
      if (s.invalidated) return false;
      if (!s.baselineSig) return !((s.totalCalls ?? 0) > 0 || (s.depth ?? 0) > 0 || s.initialActiveTicket) && env?.ADLC_P4_ENFORCEMENT !== '1';
      return s.baselineSig === computeBaselineSig(sid, s, root, env);
    },
    validateLedger(sid) {
      if (!ticketStoreExists(root, env)) return true;
      if (!existsSync(ledgerPath)) { if (!existsSync(storePath)) return true; const st = readStore(); const e = sid ? st[sid] : null; return !st._corrupted && !(e && (e.ledgerSeq > 0 || e.depth > 0 || e.totalCalls > 0)); }
      const rep = replayLedger(); if (!rep || rep._corrupted) return false;
      if (sid) { const st = readStore(); if (st._corrupted) return false; const e = st[sid]; const r = rep[sid]; if (e && r && ((r.ledgerSeq ?? 0) !== (e.ledgerSeq ?? 0) || (r.depth ?? 0) !== (e.depth ?? 0) || (r.totalCalls ?? 0) !== (e.totalCalls ?? 0) || (r.mutatingCalls ?? 0) !== (e.mutatingCalls ?? 0) || r.invalidated || e.invalidated)) return false; }
      return true;
    },
  };
}

export function checkFlail({ sessionID, tracker, env = process.env }) {
  if (!sessionID || sessionID === 'default_session') return { verdict: 'clean', signals: [], summary: '', recommendation: 'Session clean' };
  const tp = resolveTranscriptPath({ conversationId: sessionID, env });
  return analyzeFlail({ edits: tracker?.edits?.(sessionID) ?? [], transcriptSteps: tp ? parseTranscriptSteps(tp) : [] });
}
export function decideBuildGate({ riskTier, degraded, bypass, sessionID } = {}) {
  if (riskTier !== 'high') return { decision: 'allow', reason: `ticket risk tier is '${riskTier ?? 'normal'}' — gate only guards high-risk tickets` };
  if (!degraded) return { decision: 'allow', reason: 'high-risk ticket, but context-fitness is not degraded' };
  if (bypass) return { decision: 'allow', reason: 'high-risk build in a degraded session, but ADLC_BUILD_GATE_BYPASS=1 was set', overridden: true };
  return { decision: 'deny', reason: sessionID === 'default_session' ? 'high-risk ticket build denied: context depth threshold exceeded (default_session).' : 'high-risk ticket build denied: context depth threshold exceeded in this session. Resume in a fresh session.' };
}
export function checkBuildGate({ sessionID, tracker, root = process.cwd(), env = process.env }) {
  if (env.ADLC_P4_ENFORCEMENT !== '1') return { decision: 'allow', reason: 'enforcement inactive' };
  if (tracker?.isCorrupted?.()) return { decision: 'deny', reason: 'Session tracking store is corrupted or unreadable under enforcement (fail closed).' };
  if (!ticketStoreExists(root, env)) return { decision: 'allow', reason: 'repo not ADLC-initialized' };
  const active = resolveActiveTicketId(root, env);
  if (active.conflict) return { decision: 'deny', reason: active.message ?? 'ticket pointer conflict between ADLC_TICKET env and .adlc/current-ticket.json' };
  if (!active.id) return { decision: 'allow', reason: 'no unambiguous active ticket' };
  let ticket = null; try { ticket = loadStoreSnapshot(root, env).get(active.id); } catch (err) { return { decision: 'deny', reason: `corrupt or unparseable ticket store: ${err?.message ?? err}` }; }
  if (!ticket) return { decision: 'deny', reason: `active ticket ${active.id} not found in tickets.json` };
  if (tracker?.validateBaseline && !tracker.validateBaseline(sessionID)) return { decision: 'deny', reason: 'Session baseline signature mismatch (tampering detected).' };
  if (tracker?.validateLedger && !tracker.validateLedger(sessionID)) return { decision: 'deny', reason: 'Session ledger integrity verification failed (tampering or truncation detected).' };
  const { tier } = computeRiskTier(ticket); const depth = tracker?.depth?.(sessionID) ?? 0;
  if (sessionID && sessionID !== 'default_session' && depth === 0) {
    const tp = resolveTranscriptPath({ conversationId: sessionID, env }) || (existsSync(join(root, 'transcript.jsonl')) ? join(root, 'transcript.jsonl') : null);
    if (tp && parseTranscriptRecords(tp).some((r) => (r?.tool_calls ?? (r?.toolCall ? [r.toolCall] : [])).some((c) => {
      const n = c?.name ?? ''; const a = c?.args ?? {};
      return isShellTool(n, a) ? Boolean(extractCommandString(a) && !/^(node\s+--test|npm\s+test|npm\s+t\b|pnpm\s+test|yarn\s+test|echo|printf|pwd|ls|dir)\b/i.test(extractCommandString(a))) : classifyTool(n, a) !== 'readonly';
    }))) return { decision: 'deny', reason: 'ticket build denied: session tracking store was removed mid-session while transcript contains prior mutations' };
  }
  const parsedT = Number.parseInt(env.ADLC_BUILD_GATE_DEPTH_THRESHOLD ?? '', 10); const thresh = Number.isNaN(parsedT) ? DEFAULT_DEPTH_THRESHOLD : parsedT;
  const degraded = depth >= thresh || Boolean(tracker?.isCompacted?.(sessionID)) || Boolean(tracker?.isLockFailed?.(sessionID));
  const v = decideBuildGate({ riskTier: tier, degraded, bypass: env.ADLC_BUILD_GATE_BYPASS === '1', sessionID });
  if (v.decision === 'deny') return { ...v, reason: `${v.reason} [signal: ${tracker?.isLockFailed?.(sessionID) ? 'session lock timed out' : tracker?.isCompacted?.(sessionID) ? 'session was compacted' : `tool-call depth ${depth} >= ${thresh}`}]` };
  return v;
}
