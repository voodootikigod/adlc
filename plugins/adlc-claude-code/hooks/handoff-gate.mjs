// Pure helpers for the Claude Code context-handoff PreToolUse mode.
// Gate evaluation always goes through `@adlc/context-handoff` (loaded by the
// caller) — this file must not re-declare D1–D3 or HARD_*/HANDOFF_* literals.

import { basename, extname } from 'node:path';

/** Mutating `adlc handoff` subcommands agents must not run under deny-set. */
export const HANDOFF_MUTATING_SUBCOMMANDS = new Set([
  'write',
  'resume',
  'bypass',
  'repair',
  'unlock',
]);

/**
 * Session identity for deny markers / D2.
 *
 * Source order (first usable wins):
 * 1. `input.session_id` (Claude Code hook payload)
 * 2. `input.sessionId`
 * 3. basename of `transcript_path` without extension (uuid.jsonl → uuid)
 *
 * @param {object} input
 * @param {{ isSafeSessionId: (id: unknown) => boolean }} api
 * @returns {string|null}
 */
export function resolveSessionId(input, { isSafeSessionId }) {
  const candidates = [];
  if (input && typeof input === 'object') {
    candidates.push(input.session_id, input.sessionId);
    const tp = input.transcript_path;
    if (typeof tp === 'string') {
      if (tp !== '') {
        const base = basename(tp);
        const stem = base.slice(0, base.length - extname(base).length);
        candidates.push(stem);
      }
    }
  }
  for (const c of candidates) {
    if (isSafeSessionId(c)) return c;
  }
  return null;
}

/**
 * Repo-relative path is a handoff trust-root artifact agents must not Write.
 * @param {string} rel forward-slashed repo-relative path
 * @returns {boolean}
 */
export function isProtectedHandoffPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  // Collapse . / .. and separators; keep as repo-relative (no leading /).
  const norm = rel
    .replace(/\\/g, '/')
    .split('/')
    .reduce((acc, part) => {
      if (part === '' || part === '.') return acc;
      if (part === '..') {
        acc.pop();
        return acc;
      }
      acc.push(part);
      return acc;
    }, [])
    .join('/');
  if (norm === '.adlc/.deny-store' || norm === '.adlc/handoffs/.deny-store') return true;
  if (norm === '.adlc/handoffs/denies' || norm.startsWith('.adlc/handoffs/denies/')) return true;
  if (!norm.startsWith('.adlc/handoffs/')) return false;
  const leaf = basename(norm);
  return (
    leaf.endsWith('.resume-auth.json') ||
    leaf.endsWith('.model-ok') ||
    leaf.endsWith('.lock')
  );
}

/**
 * Detect `adlc handoff <mutating>` in a shell command (best-effort; under
 * deny-set Bash is denied wholesale anyway).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isHandoffMutatingShell(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  // Match adlc/npx/path handoff <sub>, including $(...) / backtick wrappers.
  const re =
    /(?:adlc\s+)?(?:[^\s;|&`'"()]*[/\\])?handoff(?:\.mjs)?\s+(\w+)/gi;
  let m;
  while ((m = re.exec(command)) !== null) {
    if (HANDOFF_MUTATING_SUBCOMMANDS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * Bash tool command string from a PreToolUse payload.
 * @param {object} input
 * @returns {string}
 */
export function bashCommandFromInput(input) {
  const ti = input?.tool_input ?? input?.parameters ?? {};
  if (typeof ti.command === 'string') return ti.command;
  if (typeof ti.cmd === 'string') return ti.cmd;
  return '';
}

function denyStoreHot(loaded) {
  if (!loaded || typeof loaded !== 'object') return true;
  if (loaded.ok === false || loaded.denyStoreUnavailable === true) return true;
  if (Array.isArray(loaded.records) && loaded.records.length > 0) return true;
  if (Array.isArray(loaded.invalidRecords) && loaded.invalidRecords.length > 0) return true;
  if (Array.isArray(loaded.registeredSessions) && loaded.registeredSessions.length > 0) {
    return true;
  }
  return false;
}

/**
 * Decide whether this PreToolUse must be denied for handoff.
 *
 * @param {object} opts
 * @param {object} opts.api `@adlc/context-handoff` namespace
 * @param {string} opts.root repo root (cwd)
 * @param {string|null} opts.sessionId
 * @param {{ depth?: number, bytes?: number, pct?: number }} opts.observed
 * @param {string|null} [opts.ticketId]
 * @param {string[]} [opts.editRelPaths] repo-relative edit targets
 * @param {boolean} [opts.isBash]
 * @param {string} [opts.bashCommand]
 * @returns {{ deny: boolean, reasons: string[], ensuredMarker: boolean }}
 */
export function evaluateHandoffPreToolUse({
  api,
  root,
  sessionId,
  observed = {},
  ticketId = null,
  editRelPaths = [],
  isBash = false,
  bashCommand = '',
}) {
  const {
    evaluateBands,
    handoffDenyActive,
    ensureDenyMarker,
    loadDenyRecords,
    mutationGateInputFromLoad,
    evaluateMutationGate,
    readResumeAuth,
    nagSuppression,
  } = api;

  const reasons = [];
  let ensuredMarker = false;
  let mutationDenied = false;

  for (const rel of editRelPaths) {
    if (isProtectedHandoffPath(rel)) {
      reasons.push(`path_protected:${rel}`);
    }
  }

  const bands = evaluateBands(observed);
  const nags = nagSuppression({ floor: observed });
  const handoffActive = handoffDenyActive(bands, nags) === true;

  const loaded = loadDenyRecords(root);
  const storeHot = denyStoreHot(loaded);

  // No usable session: fail closed only once handoff/hard pressure applies or a
  // deny store is already in play — otherwise a clean ADLC repo stays editable.
  if (!sessionId) {
    if (handoffActive || storeHot) {
      reasons.push('D0:invalid_session_id');
      mutationDenied = true;
    }
  } else {
    let processStickyDeny = false;
    if (handoffActive) {
      const ensured = ensureDenyMarker(root, {
        sessionId,
        ticketId,
        contentHash: null,
        host: 'claude-code',
      });
      if (ensured.ok) {
        ensuredMarker = true;
      } else {
        processStickyDeny = true;
        reasons.push(`ensure_deny_marker:${ensured.reason ?? 'failed'}`);
      }
    }

    // Re-load after ensure so the new marker participates in D2/D3.
    const loadedAfter = handoffActive ? loadDenyRecords(root) : loaded;
    const resumeAuth = readResumeAuth(root, sessionId);
    const gateInput = mutationGateInputFromLoad(loadedAfter, {
      currentSessionId: sessionId,
      processStickyDeny,
      resumeAuth,
      bypassForSession: false,
      manifestVerifyFailed: false,
    });
    const gate = evaluateMutationGate(gateInput);
    if (gate.deny) {
      mutationDenied = true;
      for (const r of gate.reasons) reasons.push(r);
    }
  }

  // Under deny-set (D1|D2|D3 / missing session under pressure): Bash fail-closed-all.
  if (isBash && mutationDenied) {
    reasons.push('bash_fail_closed_under_deny');
    if (isHandoffMutatingShell(bashCommand)) {
      reasons.push('bash_handoff_mutating_cli');
    }
  }

  const uniq = [];
  const seen = new Set();
  for (const r of reasons) {
    if (seen.has(r)) continue;
    seen.add(r);
    uniq.push(r);
  }
  return { deny: uniq.length > 0, reasons: uniq, ensuredMarker };
}
