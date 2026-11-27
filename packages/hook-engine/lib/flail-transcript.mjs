// flail-transcript.mjs — bounded transcript parsing, flail analysis/tracker,
// and JetSki/Antigravity transcript path resolution (symlink & traversal safe).

import {
  openSync, readSync, closeSync, lstatSync, fstatSync, readdirSync, realpathSync,
  constants as fsConstants,
} from 'node:fs';
import { join, relative, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const DEFAULT_FLAIL_THRESHOLD = 3;
export const DEFAULT_ERROR_REPEAT_THRESHOLD = 2;
export const DEFAULT_WINDOW = 200;
export const MAX_SCAN_BYTES = 262144; // 256 KiB tail window
export const ERROR_LINE_RE = /error|exception|failed|cannot|ENOENT|FAIL|ERR!/i;

const TRANSCRIPT_FILES = ['transcript.jsonl', 'transcript_full.jsonl'];
const MAX_BRAIN_SEARCH_DEPTH = 4;
const MAX_BRAIN_DIRS_VISITED = 128;

export function normalizeError(line) {
  if (typeof line !== 'string') return '';
  if (line.length > 2048) line = line.slice(0, 2048);
  return line
    .toLowerCase()
    .replace(/0x[0-9a-f]+/gi, '')
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/\b[A-Za-z]:\\[^\s]*/g, '')
    .replace(/\b\S+\/[^\s]*/g, '')
    .replace(/\/[^\s]*/g, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectRepeatedErrors(steps, maxRepeat = DEFAULT_ERROR_REPEAT_THRESHOLD) {
  const counts = new Map();
  for (const item of steps) {
    const stepLines = typeof item === 'string' ? [item] : (Array.isArray(item) ? item : []);
    const stepSigs = new Set();
    for (const line of stepLines) {
      if (typeof line !== 'string' || !ERROR_LINE_RE.test(line)) continue;
      const sig = normalizeError(line);
      if (!sig || sig.length < 5 || /^(created|completed) at:?$/.test(sig)) continue;
      stepSigs.add(sig);
    }
    for (const sig of stepSigs) counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  const results = [];
  for (const [signature, count] of counts.entries()) {
    if (count >= maxRepeat) results.push({ signature, count });
  }
  return results;
}

export function detectEditChurn(logLines, threshold = DEFAULT_FLAIL_THRESHOLD) {
  const counts = new Map();
  const baseCounts = new Map();
  let totalEdits = 0;
  for (const line of logLines) {
    const match = typeof line === 'string' ? line.match(/^Editing\s+(.+)$/) : null;
    if (!match?.[1]) continue;
    totalEdits++;
    const p = match[1].trim();
    counts.set(p, (counts.get(p) ?? 0) + 1);
    const base = basename(p).replace(/\d+/g, '#');
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const result = [];
  for (const [path, count] of counts.entries()) {
    if (count >= threshold) result.push({ path, count });
  }
  for (const [base, count] of baseCounts.entries()) {
    if (base.includes('#') && count >= threshold && !result.some((r) => r.path === base)) {
      result.push({ path: `pattern:${base}`, count });
    }
  }
  if (totalEdits >= threshold * 4 && result.length === 0) {
    result.push({ path: 'total_edits_velocity', count: totalEdits });
  }
  return result;
}

function checkRegularTranscriptInside(candidatePath, realRoot) {
  try {
    const lst = lstatSync(candidatePath);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    const real = realpathSync(candidatePath);
    const rel = relative(realRoot, real);
    return !rel.startsWith('..') && !isAbsolute(rel) ? real : null;
  } catch { return null; }
}

function findNestedTranscript(dir, cid, realAppRoot, depth, state) {
  if (depth > MAX_BRAIN_SEARCH_DEPTH || state.visited >= MAX_BRAIN_DIRS_VISITED) return null;
  state.visited += 1;
  try {
    const lst = lstatSync(dir);
    if (lst.isSymbolicLink() || !lst.isDirectory()) return null;
  } catch { return null; }
  for (const fname of TRANSCRIPT_FILES) {
    const found = checkRegularTranscriptInside(join(dir, cid, '.system_generated', 'logs', fname), realAppRoot);
    if (found) return found;
  }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name === cid || entry.name === '.system_generated') continue;
    const found = findNestedTranscript(join(dir, entry.name), cid, realAppRoot, depth + 1, state);
    if (found) return found;
  }
  return null;
}

export function resolveTranscriptPath({ payload, conversationId, env = process.env } = {}) {
  const effectiveHome = env?.HOME || env?.USERPROFILE || homedir();
  const appDataDirs = [...new Set([
    env?.ANTIGRAVITY_APP_DATA_DIR,
    env?.JETSKI_APP_DATA_DIR,
    env?.GEMINI_CLI_DATA_DIR,
    join(effectiveHome, '.gemini', 'antigravity-cli'),
    join(effectiveHome, '.gemini', 'jetski'),
  ].filter((d) => typeof d === 'string' && d.trim()))];

  const direct = payload?.transcriptPath ?? payload?.transcript_path ?? payload?.logPath ?? payload?.log_path;
  const cidFromPayload =
    payload?.conversationId ?? payload?.conversation_id ?? payload?.conversationID ??
    payload?.sessionID ?? payload?.sessionId ?? payload?.params?.conversationId ?? payload?.params?.conversation_id;
  const cidFromEnv = env?.ADLC_SESSION_ID ?? env?.AGY_SESSION_ID ?? env?.GEMINI_SESSION_ID;
  const cid = cidFromPayload
    ?? (typeof conversationId === 'string' && conversationId !== 'default_session' ? conversationId : null)
    ?? (typeof cidFromEnv === 'string' && cidFromEnv !== 'default_session' ? cidFromEnv : null);

  if (typeof direct === 'string' && direct.trim()) {
    const trimmed = direct.trim();
    if (!trimmed.split(/[/\\]/).includes('..') && /(^|[/\\]).*transcript.*\.jsonl$/i.test(trimmed)) {
      const allowedRoots = [
        ...appDataDirs, env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE,
        env?.GEMINI_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT,
      ].filter((r) => typeof r === 'string' && r.trim());
      for (const r of allowedRoots) {
        try {
          const verified = checkRegularTranscriptInside(trimmed, realpathSync(r));
          if (verified) return verified;
        } catch {}
      }
    }
  }

  if (!cid || typeof cid !== 'string' || cid.includes('..') || cid.includes('/') || cid.includes('\\')) return null;

  for (const appDir of appDataDirs) {
    let realAppRoot;
    try { realAppRoot = realpathSync(appDir); } catch { continue; }
    const brainDir = join(appDir, 'brain');
    for (const fname of TRANSCRIPT_FILES) {
      const found = checkRegularTranscriptInside(join(brainDir, cid, '.system_generated', 'logs', fname), realAppRoot);
      if (found) return found;
    }
    const nested = findNestedTranscript(brainDir, cid, realAppRoot, 0, { visited: 0 });
    if (nested) return nested;
  }
  return null;
}

function parseJsonLine(rawLine) {
  try { return JSON.parse(rawLine); } catch { return { content: rawLine, __unparseable: true }; }
}

export function parseTranscriptRecords(filePath, options = {}) {
  const isObj = typeof options === 'object' && options !== null;
  const maxScanBytes = typeof options === 'number' ? options : (options?.maxScanBytes ?? MAX_SCAN_BYTES);
  const readFull = isObj && options.readFull === true;
  const maxRecords = isObj ? (options.maxRecords ?? 50000) : 50000;
  const maxLineLength = isObj ? (options.maxLineLength ?? 1048576) : 1048576;
  const maxTotalBytes = isObj ? (options.maxTotalBytes ?? (16 * 1024 * 1024)) : (16 * 1024 * 1024);
  if (!filePath) return [];
  let fd;
  try { fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK); } catch { return []; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return [];
    const records = [];
    if (readFull) {
      const buf = Buffer.alloc(65536);
      let leftover = ''; let pos = 0; let totalBytes = 0;
      while (pos < stat.size) {
        const bytesRead = readSync(fd, buf, 0, Math.min(buf.length, stat.size - pos), pos);
        if (bytesRead <= 0) break;
        pos += bytesRead; totalBytes += bytesRead;
        if (totalBytes > maxTotalBytes) { records.push({ content: 'oversized_transcript', __oversized: true }); return records; }
        const lines = (leftover + buf.toString('utf8', 0, bytesRead)).split('\n');
        leftover = lines.pop() ?? '';
        if (leftover.length > maxLineLength) { records.push({ content: 'unterminated_oversized_line', __oversized: true }); return records; }
        for (const rawLine of lines) {
          if (!rawLine.trim()) continue;
          if (records.length >= maxRecords) { records.push({ content: 'oversized_transcript', __oversized: true }); return records; }
          records.push(rawLine.length > maxLineLength ? { content: 'oversized_line', __unparseable: true } : parseJsonLine(rawLine));
        }
      }
      if (leftover.trim()) records.push(records.length >= maxRecords ? { content: 'oversized_transcript', __oversized: true } : parseJsonLine(leftover));
      return records;
    }
    const readLen = Math.min(stat.size, maxScanBytes);
    const buf = Buffer.alloc(readLen);
    let pos = 0;
    const start = stat.size > maxScanBytes ? stat.size - maxScanBytes : 0;
    while (pos < readLen) {
      const n = readSync(fd, buf, pos, readLen - pos, start + pos);
      if (n <= 0) break;
      pos += n;
    }
    let content = buf.toString('utf8', 0, pos);
    if (start > 0) { const nl = content.indexOf('\n'); if (nl !== -1) content = content.slice(nl + 1); }
    for (const rawLine of content.split('\n')) {
      if (rawLine.trim()) records.push(parseJsonLine(rawLine));
    }
    return records;
  } catch { return []; } finally { try { closeSync(fd); } catch {} }
}

function isNonErrorStepRecord(obj) {
  const stepType = typeof obj.type === 'string' ? obj.type.toUpperCase() : '';
  const status = typeof obj.status === 'string' ? obj.status.toUpperCase() : '';
  if (status === 'ERROR') return false;
  if (stepType === 'USER_INPUT' || stepType === 'PLANNER_RESPONSE') return true;
  if (status === 'DONE') {
    const body = typeof obj.content === 'string' ? obj.content : '';
    if (/Showing lines \d+-\d+ of \d+/.test(body) || /Command exited with code 0\./.test(body)) return true;
  }
  return false;
}

export function parseTranscriptSteps(filePath, maxScanBytes = MAX_SCAN_BYTES) {
  const steps = [];
  for (const obj of parseTranscriptRecords(filePath, maxScanBytes)) {
    if (!obj || typeof obj !== 'object') { if (typeof obj === 'string' && obj.trim()) steps.push([obj]); continue; }
    if (isNonErrorStepRecord(obj)) continue;
    const stepLines = [];
    for (const k of ['content', 'text', 'message', 'error']) {
      if (typeof obj[k] === 'string') stepLines.push(...obj[k].split('\n'));
    }
    if (stepLines.length > 0) steps.push(stepLines);
  }
  return steps;
}

export function parseTranscriptLines(filePath, maxScanBytes = MAX_SCAN_BYTES) {
  return parseTranscriptSteps(filePath, maxScanBytes).flat();
}

export function analyzeFlail({ edits = [], transcriptSteps = [], transcriptLines = [], threshold = DEFAULT_FLAIL_THRESHOLD, maxErrorRepeat = DEFAULT_ERROR_REPEAT_THRESHOLD } = {}) {
  const churning = detectEditChurn(edits, threshold);
  const errorSteps = [...transcriptSteps, ...(transcriptLines.length > 0 && transcriptSteps.length === 0 ? transcriptLines.map((l) => [l]) : [])];
  const repeatedErrors = detectRepeatedErrors(errorSteps, maxErrorRepeat);
  const signals = [];
  if (churning.length > 0) signals.push({ type: 'edit-churn', entries: churning });
  if (repeatedErrors.length > 0) signals.push({ type: 'repeated-error', entries: repeatedErrors });
  const isFlailing = signals.length > 0;
  const parts = [];
  if (churning.length > 0) parts.push(`file edit churn (${churning.map((c) => `${c.path} ${c.count}×`).join(', ')})`);
  if (repeatedErrors.length > 0) parts.push(`repeated error signatures (${repeatedErrors.map((e) => `"${e.signature}" ${e.count}×`).join(', ')})`);
  const summary = parts.join('; ');
  return {
    verdict: isFlailing ? 'flail' : 'clean',
    signals,
    summary,
    recommendation: isFlailing
      ? `ADLC anti-flail: session is flailing (${summary}). Consider stepping back, isolating root causes, or starting a fresh session rather than continuing to retry.`
      : 'Session clean',
  };
}

export function createFlailTracker({ window = DEFAULT_WINDOW, threshold = DEFAULT_FLAIL_THRESHOLD, maxErrorRepeat = DEFAULT_ERROR_REPEAT_THRESHOLD } = {}) {
  const lines = new Map();
  const warned = new Map();
  return {
    record({ sessionID, filePath, transcriptSteps = [], transcriptLines = [] }) {
      if (!sessionID) return { churning: [], repeatedErrors: [], verdict: 'clean', summary: '' };
      const buf = lines.get(sessionID) ?? [];
      if (filePath) {
        buf.push(`Editing ${filePath}`);
        if (buf.length > window) buf.splice(0, buf.length - window);
        lines.set(sessionID, buf);
      }
      const analysis = analyzeFlail({ edits: buf, transcriptSteps, transcriptLines, threshold, maxErrorRepeat });
      const hashKey = createHash('sha1').update(JSON.stringify(analysis.signals)).digest('hex').slice(0, 16);
      const seenHashes = warned.get(sessionID) ?? new Set();
      const isNew = analysis.verdict === 'flail' && !seenHashes.has(hashKey);
      if (isNew) { seenHashes.add(hashKey); warned.set(sessionID, seenHashes); }
      const steps = [...buf.map((e) => [e]), ...transcriptSteps, ...(transcriptLines.length > 0 && transcriptSteps.length === 0 ? transcriptLines.map((l) => [l]) : [])];
      return {
        churning: detectEditChurn(buf, threshold),
        repeatedErrors: detectRepeatedErrors(steps, maxErrorRepeat),
        verdict: analysis.verdict,
        signals: analysis.signals,
        summary: analysis.summary,
        recommendation: analysis.recommendation,
        isNewSignal: isNew,
      };
    },
    evict(sessionID) { lines.delete(sessionID); warned.delete(sessionID); },
  };
}

export function flailMessage({ path, count }) {
  return `ADLC flail check: ${path} has been edited ${count}× this session — repeated rewrites often signal the model is stuck. Consider stepping back or starting a fresh session.`;
}
