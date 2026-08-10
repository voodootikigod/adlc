// Harness-agnostic adapter core for the context-rot handoff gate.
//
// Every enforcing harness (Claude Code, Codex, OpenCode, Pi) needs the same
// four decisions on a mutation-tool call: which session am I, is this path a
// handoff trust-root artifact, is this shell command a mutating `adlc handoff`
// invocation, and does the deny-set (D1-D3) block me right now. Slice 4 grew
// them inside the Claude Code plugin; they live here so the later adapters
// import them rather than forking D1-D3 or the protected-path list.
//
// What stays in each adapter is only the harness-specific I/O: reading its
// payload shape, observing its context signals, and emitting its deny.

import { basename, extname } from 'node:path';

import {
  isSafeSessionId,
  ensureDenyMarker,
  loadDenyRecords,
  mutationGateInputFromLoad,
} from './deny-marker.mjs';
import { evaluateBands, nagSuppression, handoffDenyActive } from './bands.mjs';
import { evaluateMutationGate } from './mutation-gate.mjs';
import { readResumeAuth } from './resume-auth.mjs';

/** Mutating `adlc handoff` subcommands agents must not run under deny-set. */
export const HANDOFF_MUTATING_SUBCOMMANDS = new Set([
  'write',
  'resume',
  'bypass',
  'repair',
  'unlock',
]);

/**
 * Session identity for deny markers / D2, from whatever the harness offers.
 *
 * Candidates are tried in order; the first one `isSafeSessionId` accepts wins.
 * A transcript path contributes its basename without extension (uuid.jsonl →
 * uuid) as a last candidate — an empty string never does.
 *
 * @param {{ candidates?: unknown[], transcriptPath?: unknown }} opts
 * @returns {string|null}
 */
export function resolveHandoffSessionId({ candidates = [], transcriptPath } = {}) {
  const all = [...candidates];
  if (typeof transcriptPath === 'string' && transcriptPath !== '') {
    const base = basename(transcriptPath);
    all.push(base.slice(0, base.length - extname(base).length));
  }
  for (const c of all) {
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
 * deny-set the shell is denied wholesale anyway).
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
 * True when the deny store is in play at all: any record, any invalid record,
 * any registered session, or a store that could not be read. A cold store on a
 * repo that never hit the handoff band is the fail-OPEN case — an adapter
 * installed on a clean repo must not brick it.
 * @param {object} loaded result of `loadDenyRecords`
 * @returns {boolean}
 */
export function denyStoreHot(loaded) {
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
 * Decide whether a mutation-tool call must be denied for handoff.
 *
 * Harness-agnostic: the caller supplies an already-resolved session id, the
 * observed context signals, the repo-relative edit targets, and whether the
 * call is a shell. Thresholds and D1-D3 are never re-declared by the caller.
 *
 * @param {object} opts
 * @param {string} opts.root repo root (cwd)
 * @param {string|null} opts.sessionId
 * @param {{ depth?: number, bytes?: number, pct?: number }} [opts.observed]
 * @param {string|null} [opts.ticketId]
 * @param {string[]} [opts.editRelPaths] repo-relative edit targets
 * @param {boolean} [opts.isBash]
 * @param {string} [opts.bashCommand]
 * @param {string} [opts.host] recorded on the deny marker
 * @returns {{ deny: boolean, reasons: string[], ensuredMarker: boolean }}
 */
export function evaluateHandoffPreToolUse({
  root,
  sessionId,
  observed = {},
  ticketId = null,
  editRelPaths = [],
  isBash = false,
  bashCommand = '',
  host = 'unknown',
}) {
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
        host,
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

  // Under deny-set (D1|D2|D3 / missing session under pressure): shell fail-closed-all.
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
