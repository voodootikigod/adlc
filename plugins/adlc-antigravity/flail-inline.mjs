// flail-inline.mjs — self-contained target-file edit churn and error flail tracking for adlc-antigravity.
// Uses ONLY Node builtins (no npm @adlc/* runtime dependencies).

import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const DEFAULT_FLAIL_THRESHOLD = 3;
export const DEFAULT_ERROR_REPEAT_THRESHOLD = 2;
export const DEFAULT_WINDOW = 200;
export const MAX_SCAN_BYTES = 262144; // 256 KiB tail window

export const ERROR_LINE_RE = /error|exception|failed|cannot|ENOENT|FAIL|ERR!/i;

/**
 * Normalize an error line for signature comparison:
 * Lowercase, strip hex, quotes, absolute paths, digits, collapse whitespace.
 */
export function normalizeError(line) {
  if (typeof line !== 'string') return '';
  return line
    .toLowerCase()
    .replace(/0x[0-9a-f]+/gi, '')
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/(?:\b[A-Za-z]:\\[^\s]*|(?:\/|\b[\w.-]+\/)[^\s]*)/g, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find error-line signatures that appear >= maxRepeat times.
 */
export function detectRepeatedErrors(lines, maxRepeat = DEFAULT_ERROR_REPEAT_THRESHOLD) {
  const counts = new Map();
  for (const line of lines) {
    if (typeof line !== 'string' || !ERROR_LINE_RE.test(line)) continue;
    const sig = normalizeError(line);
    if (!sig || sig.length < 5) continue;
    if (/^created at:?$/.test(sig) || /^completed at:?$/.test(sig)) continue;
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  const results = [];
  for (const [signature, count] of counts.entries()) {
    if (count >= maxRepeat) {
      results.push({ signature, count });
    }
  }
  return results;
}

/**
 * Detect edit churn on files appearing >= threshold times in edit log lines.
 */
export function detectEditChurn(logLines, threshold = DEFAULT_FLAIL_THRESHOLD) {
  const counts = new Map();
  for (const line of logLines) {
    const match = typeof line === 'string' ? line.match(/^Editing\s+(.+)$/) : null;
    if (match?.[1]) {
      const path = match[1].trim();
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  const result = [];
  for (const [path, count] of counts.entries()) {
    if (count >= threshold) result.push({ path, count });
  }
  return result;
}

/**
 * Resolve transcript path for a given agy conversation ID or payload.
 */
export function resolveTranscriptPath({ payload, conversationId, env = process.env } = {}) {
  const cidFromPayload = payload?.conversationId ?? payload?.conversation_id ?? payload?.conversationID ?? payload?.sessionID ?? payload?.sessionId ?? payload?.params?.conversationId ?? payload?.params?.conversation_id;
  let cid = cidFromPayload;
  if (!cid && !payload && typeof conversationId === 'string' && conversationId !== 'default_session') {
    cid = conversationId;
  }
  if (!cid || typeof cid !== 'string') return null;
  if (cid.includes('..') || cid.includes('/') || cid.includes('\\')) return null;

  const appDataDir = env?.ANTIGRAVITY_APP_DATA_DIR ?? env?.GEMINI_CLI_DATA_DIR ?? join(homedir(), '.gemini', 'antigravity-cli');
  const transcriptPath = join(appDataDir, 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl');
  if (existsSync(transcriptPath)) return transcriptPath;
  const fullTranscriptPath = join(appDataDir, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (existsSync(fullTranscriptPath)) return fullTranscriptPath;
  return null;
}

/**
 * Safely parse recent lines from an agy transcript JSONL file.
 */
export function parseTranscriptLines(filePath, maxScanBytes = MAX_SCAN_BYTES) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const stat = statSync(filePath);
    let content = '';
    if (stat.size > maxScanBytes) {
      const fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(maxScanBytes);
      readSync(fd, buf, 0, maxScanBytes, stat.size - maxScanBytes);
      closeSync(fd);
      content = buf.toString('utf8');
      const firstNewline = content.indexOf('\n');
      if (firstNewline !== -1) content = content.slice(firstNewline + 1);
    } else {
      content = readFileSync(filePath, 'utf8');
    }
    const extracted = [];
    for (const rawLine of content.split('\n')) {
      if (!rawLine.trim()) continue;
      try {
        const obj = JSON.parse(rawLine);
        if (obj.content && typeof obj.content === 'string') {
          extracted.push(...obj.content.split('\n'));
        }
        if (obj.text && typeof obj.text === 'string') {
          extracted.push(...obj.text.split('\n'));
        }
        if (obj.message && typeof obj.message === 'string') {
          extracted.push(...obj.message.split('\n'));
        }
      } catch {
        extracted.push(rawLine);
      }
    }
    return extracted;
  } catch {
    return [];
  }
}

/**
 * Unified flail analysis across file edit churn, repeated errors, and transcript logs.
 */
export function analyzeFlail({ edits = [], transcriptLines = [], threshold = DEFAULT_FLAIL_THRESHOLD, maxErrorRepeat = DEFAULT_ERROR_REPEAT_THRESHOLD } = {}) {
  const churning = detectEditChurn(edits, threshold);
  const errorLines = [...edits, ...transcriptLines];
  const repeatedErrors = detectRepeatedErrors(errorLines, maxErrorRepeat);

  const signals = [];
  if (churning.length > 0) {
    signals.push({ type: 'edit-churn', entries: churning });
  }
  if (repeatedErrors.length > 0) {
    signals.push({ type: 'repeated-error', entries: repeatedErrors });
  }

  const isFlailing = signals.length > 0;
  let summary = '';
  if (isFlailing) {
    const parts = [];
    if (churning.length > 0) {
      parts.push(`file edit churn (${churning.map((c) => `${c.path} ${c.count}×`).join(', ')})`);
    }
    if (repeatedErrors.length > 0) {
      parts.push(`repeated error signatures (${repeatedErrors.map((e) => `"${e.signature}" ${e.count}×`).join(', ')})`);
    }
    summary = parts.join('; ');
  }

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
    record({ sessionID, tool, filePath, transcriptLines = [] }) {
      if (!sessionID) return { churning: [], repeatedErrors: [], verdict: 'clean', summary: '' };
      const buf = lines.get(sessionID) ?? [];
      if (filePath) {
        buf.push(`Editing ${filePath}`);
        if (buf.length > window) buf.splice(0, buf.length - window);
        lines.set(sessionID, buf);
      }

      const analysis = analyzeFlail({ edits: buf, transcriptLines, threshold, maxErrorRepeat });
      const hashKey = createHash('sha1').update(JSON.stringify(analysis.signals)).digest('hex').slice(0, 16);

      const seenHashes = warned.get(sessionID) ?? new Set();
      const isNew = analysis.verdict === 'flail' && !seenHashes.has(hashKey);
      if (isNew) {
        seenHashes.add(hashKey);
        warned.set(sessionID, seenHashes);
      }

      const churning = detectEditChurn(buf, threshold);
      const repeatedErrors = detectRepeatedErrors([...buf, ...transcriptLines], maxErrorRepeat);

      return {
        churning,
        repeatedErrors,
        verdict: analysis.verdict,
        signals: analysis.signals,
        summary: analysis.summary,
        recommendation: analysis.recommendation,
        isNewSignal: isNew,
      };
    },
    evict(sessionID) {
      lines.delete(sessionID);
      warned.delete(sessionID);
    },
  };
}

export function flailMessage({ path, count }) {
  return `ADLC flail check: ${path} has been edited ${count}× this session — repeated rewrites often signal the model is stuck. Consider stepping back or starting a fresh session.`;
}

