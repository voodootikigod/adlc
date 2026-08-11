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
  evaluateMarkerOnReentry,
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
 * Literal path-like tokens in a shell command, plus every directory prefix of
 * each one.
 *
 * The prefixes matter: `rm -rf .adlc/handoffs` names a DIRECTORY, and the
 * protected-path predicate answers about the artifacts inside it. Without
 * expanding prefixes, deleting the whole tree would read as untouched while
 * deleting one marker inside it would be caught — exactly backwards.
 *
 * @param {unknown} command
 * @returns {string[]}
 */
export function shellPathCandidates(command) {
  if (typeof command !== 'string' || command === '') return [];
  const out = new Set();
  // Strip quotes, then take whitespace/;|&-separated tokens that look like paths.
  for (const raw of command.replace(/['"]/g, ' ').split(/[\s;|&()<>]+/)) {
    const token = raw.replace(/^-+/, '');
    if (token === '' || !token.includes('/')) continue;
    const norm = token.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm === '') continue;
    out.add(norm);
    // Every ancestor, so a directory-level target is seen as covering its
    // contents: `.adlc/handoffs` → also `.adlc/handoffs/denies`.
    const parts = norm.split('/');
    for (let i = 1; i < parts.length; i += 1) out.add(parts.slice(0, i).join('/'));
  }
  // `.adlc/handoffs` is protected via its `denies` child; name it explicitly so a
  // directory-level delete is recognized.
  const expanded = new Set(out);
  for (const p of out) {
    if (p === '.adlc/handoffs' || p === '.adlc') {
      expanded.add('.adlc/handoffs/denies');
      expanded.add('.adlc/.deny-store');
    }
  }
  return [...expanded];
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
 * @param {string|null} [opts.manifestKey] signing key used to VERIFY a
 *        resume-auth cache. Without it `readResumeAuth` can only ever report
 *        `verified:false`, and `authorized()` requires `verified === true` — so
 *        a correctly signed resume could never clear a deny through an adapter.
 *        Adapters pass their own `ADLC_MANIFEST_KEY`; absent, the gate still
 *        fails closed, it just cannot be re-opened in-session.
 * @param {boolean} [opts.denyEverWritten] caller-threaded D1 fact: this session
 *        has already had a deny marker written OR attempted. `processStickyDeny`
 *        is a per-call local, so without this a marker write that FAILED denies
 *        one call and then fails open once the band cools. Only a caller with
 *        memory across calls can carry it; the spec makes it caller-threaded for
 *        exactly that reason.
 * @returns {{ deny: boolean, reasons: string[], ensuredMarker: boolean, denyEverWritten: boolean }}
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
  manifestKey = null,
  denyEverWritten = false,
}) {
  const reasons = [];
  let ensuredMarker = false;
  let mutationDenied = false;
  let sawDeny = denyEverWritten === true;

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
      sawDeny = true;
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
    } else if (sawDeny) {
      // D1 re-entry: this session already had a marker written or attempted, so
      // a cooling signal must not clear it. A failed write leaves nothing on
      // disk, which is exactly the case a cold store would otherwise allow.
      const reentry = evaluateMarkerOnReentry(root, sessionId, {
        absoluteHandoff: false,
        denyEverWritten: true,
      });
      if (reentry.deny) {
        processStickyDeny = processStickyDeny || reentry.processSticky === true;
        reasons.push(`D1:${reentry.reason}`);
        mutationDenied = true;
      }
    }

    // Re-load after ensure so the new marker participates in D2/D3.
    const loadedAfter = handoffActive ? loadDenyRecords(root) : loaded;
    // Without a key `readResumeAuth` reports verified:false for every document,
    // and `authorized()` demands verified === true — so a signed resume can only
    // ever clear a deny when the adapter supplies the key it was signed with.
    const resumeAuth = readResumeAuth(
      root,
      sessionId,
      typeof manifestKey === 'string' && manifestKey.length > 0 ? { key: manifestKey } : {},
    );
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

    // Diagnostic only, and only once the call is already denied: an operator who
    // ran `adlc handoff resume` and is still blocked needs to know the adapter
    // could not verify the cache, rather than assuming the resume failed.
    if (mutationDenied && resumeAuth && resumeAuth.verified !== true) {
      reasons.push(
        typeof manifestKey === 'string' && manifestKey.length > 0
          ? 'resume_auth_unverified'
          : 'resume_auth_unverifiable:no_manifest_key',
      );
    }
  }

  // Under deny-set (D1|D2|D3 / missing session under pressure): shell fail-closed-all.
  if (isBash && mutationDenied) {
    reasons.push('bash_fail_closed_under_deny');
    if (isHandoffMutatingShell(bashCommand)) {
      reasons.push('bash_handoff_mutating_cli');
    }
  }

  // A shell touching the deny store is denied whether or not a deny is active.
  //
  // Without this, a session whose record was just consumed has no D1-D3 and can
  // `rm -rf .adlc/handoffs .adlc/.deny-store` — erasing the durable identity that
  // keeps the ORIGINAL denier sticky. There is no CI backstop for that: those
  // paths are gitignored (`.adlc/*`), so the deletion never appears in a diff.
  //
  // Best-effort by construction: this reads literal paths out of the command and
  // cannot see through variables, expansion, or an interpreter one-liner — the
  // same limitation the rail shell classifier documents. It raises the cost of
  // the obvious attempt; the durable fix is host-owned storage the agent's shell
  // cannot reach at all.
  if (isBash) {
    for (const token of shellPathCandidates(bashCommand)) {
      if (isProtectedHandoffPath(token)) {
        reasons.push(`path_protected_shell:${token}`);
      }
    }
  }

  const uniq = [];
  const seen = new Set();
  for (const r of reasons) {
    if (seen.has(r)) continue;
    seen.add(r);
    uniq.push(r);
  }
  return { deny: uniq.length > 0, reasons: uniq, ensuredMarker, denyEverWritten: sawDeny };
}
