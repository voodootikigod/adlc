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

import { basename, extname, dirname, join, relative, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

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
 * Repo-relative form of `rel` with filesystem aliases resolved.
 *
 * `isProtectedHandoffPath` is lexical — it answers about the string it is
 * given. A repository can therefore point `alias.json` at
 * `.adlc/handoffs/denies/x.json`, hand the gate the innocuous name, and have
 * the filesystem follow the link. Rails-guard resolves both forms for exactly
 * this reason; the handoff store deserves the same treatment.
 *
 * Resolves the nearest EXISTING ancestor so a not-yet-created file inside a
 * symlinked directory is still caught, and returns null when nothing can be
 * resolved (the caller then relies on the lexical check alone).
 *
 * @param {string} root repo root
 * @param {string} rel repo-relative path
 * @returns {string|null}
 */
export function resolvedRepoRelative(root, rel) {
  if (typeof root !== 'string' || root === '' || typeof rel !== 'string' || rel === '') {
    return null;
  }
  try {
    const absolute = resolve(root, rel);
    let probe = absolute;
    const trailing = [];
    // Walk up to the nearest path that exists, remembering what we skipped.
    for (let i = 0; i < 64; i += 1) {
      if (existsSync(probe)) break;
      const parent = dirname(probe);
      if (parent === probe) return null;
      trailing.unshift(basename(probe));
      probe = parent;
    }
    if (!existsSync(probe)) return null;
    const realRoot = realpathSync(root);
    const realTarget = join(realpathSync(probe), ...trailing);
    const back = relative(realRoot, realTarget).replace(/\\/g, '/');
    return back === '' || back.startsWith('..') ? null : back;
  } catch {
    return null;
  }
}

/**
 * True when a path is a protected handoff artifact by its own name OR by what
 * it resolves to on disk.
 *
 * @param {string} root repo root
 * @param {string} rel repo-relative path
 * @returns {{ protected: boolean, via: 'lexical'|'symlink'|null }}
 */
export function classifyHandoffPath(root, rel) {
  if (isProtectedHandoffPath(rel)) return { protected: true, via: 'lexical' };
  const resolved = resolvedRepoRelative(root, rel);
  if (resolved !== null && resolved !== rel && isProtectedHandoffPath(resolved)) {
    return { protected: true, via: 'symlink' };
  }
  return { protected: false, via: null };
}

/**
 * Literal path-like tokens in a shell command, plus every directory prefix of
 * each one.
 *
 * The prefixes matter: `rm -rf .adlc/handoffs/denies/..` names an ancestor, and
 * the protected-path predicate answers about the artifacts under it.
 *
 * Slashless tokens are kept: `.adlc` names the directory holding every
 * protected artifact, and dropping it let `rm -rf .adlc` through while
 * `rm -rf .adlc/handoffs` was caught. Tokens that name nothing resolve to
 * themselves and classify as unprotected, so the extra candidates cost a
 * failed stat each.
 *
 * @param {unknown} command
 * @returns {string[]}
 */
export function shellPathCandidates(command) {
  if (typeof command !== 'string' || command === '') return [];
  const out = new Set();
  // Strip quotes, then take whitespace/;|&-separated tokens.
  for (const raw of command.replace(/['"]/g, ' ').split(/[\s;|&()<>]+/)) {
    const token = raw.replace(/^-+/, '');
    if (token === '') continue;
    const norm = token.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm === '') continue;
    out.add(norm);
    // Every ancestor, so a deep target is seen as reaching through them.
    const parts = norm.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      if (prefix !== '') out.add(prefix);
    }
  }
  return [...out];
}

/** Repo-relative artifacts a shell target must not be able to reach. */
const PROTECTED_SHELL_ROOTS = ['.adlc/handoffs/denies', '.adlc/.deny-store'];

/**
 * True when deleting `rel` would take a protected artifact with it — `rel` is
 * an ancestor DIRECTORY of one, rather than the artifact itself.
 *
 * The repo root is deliberately NOT covered. Candidates include every ancestor
 * of every token, so `.` is synthesized by any dot-relative path and the root
 * by any absolute in-repo path: treating the root as protected denied ordinary
 * commands like `cat ./src/app.mjs`. A target that erases the whole checkout is
 * outside what this guard can distinguish.
 *
 * @param {string} rel repo-relative, already normalized, never ''
 * @returns {boolean}
 */
function coversProtectedRoot(rel) {
  if (rel === '') return false;
  return PROTECTED_SHELL_ROOTS.some((p) => p === rel || p.startsWith(`${rel}/`));
}

/**
 * Classify a mutation TARGET — a path some tool is about to act on.
 *
 * Distinct from `classifyHandoffPath` in one way that matters: a target may be
 * a DIRECTORY, and the question is what acting on it can reach, not whether the
 * token is itself an artifact. It is therefore decided on the RESOLVED
 * repo-relative form. Deciding directory coverage on the raw token meant
 * `.adlc/handoffs` was caught while `./.adlc`, `/abs/repo/.adlc`, and
 * `/abs/repo/.adlc/handoffs` were not, because only the literal spellings were
 * expanded.
 *
 * Used for structured targets as well as shell tokens. It was shell-only at
 * first, on the reasoning that a structured target is a file rather than a
 * directory — true of a harness's own write/edit tools, false of the
 * third-party tools OpenCode and pi deliberately route through the same path.
 * A delete/move tool handed `{target: '.adlc/handoffs'}` was unprotected while
 * `rm -rf .adlc/handoffs` was denied.
 *
 * @param {string} root repo root
 * @param {string} rel candidate path
 * @returns {{ protected: boolean, via: 'lexical'|'symlink'|'covers'|null }}
 */
export function classifyProtectedTarget(root, rel) {
  const direct = classifyHandoffPath(root, rel);
  if (direct.protected) return direct;
  const resolved = resolvedRepoRelative(root, rel);
  if (resolved !== null && coversProtectedRoot(resolved)) {
    return { protected: true, via: 'covers' };
  }
  return { protected: false, via: null };
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
    const verdict = classifyProtectedTarget(root, rel);
    if (verdict.protected) {
      reasons.push(verdict.via === 'symlink' ? `path_protected_symlink:${rel}` : `path_protected:${rel}`);
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
  // Every literal spelling of the same target is caught — relative, dot-relative,
  // absolute, symlinked, and the parent directories each reaches through —
  // because the decision is made on the RESOLVED repo-relative path.
  //
  // Best-effort by construction: this reads literal paths out of the command and
  // cannot see through variables, expansion, or an interpreter one-liner — the
  // same limitation the rail shell classifier documents. It raises the cost of
  // the obvious attempt; the durable fix is host-owned storage the agent's shell
  // cannot reach at all (T-01KZRCNX3TSJ4C0PXZ28C9CB5N).
  if (isBash) {
    for (const token of shellPathCandidates(bashCommand)) {
      const verdict = classifyProtectedTarget(root, token);
      if (verdict.protected) {
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
