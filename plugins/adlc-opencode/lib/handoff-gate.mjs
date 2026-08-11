// handoff-gate.mjs — OpenCode's context-rot handoff deny (slice 5 of
// docs/specs/context-rot-handoff.md). OpenCode is an ENFORCING tier: under the
// deny-set the agent loses structured edits AND the shell wholesale.
//
// D1-D3, the band thresholds, the protected-path list and the mutating-shell
// detector all come from `@adlc/context-handoff`. Unlike the hook-script
// harnesses, this plugin IS loaded by the host as an npm package, so it simply
// declares the dependency and imports it.
//
// Session identity is the host's own `input.sessionID`. The depth signal is the
// in-process tracker the build-gate backstop already maintains — OpenCode
// exposes no transcript file, so depth is the only signal available, and the
// OR-join ignores the kinds that are missing rather than reading them as zero.

import { relative, isAbsolute, resolve } from 'node:path';

import {
  evaluateHandoffPreToolUse,
  isHandoffMutatingShell,
} from '@adlc/context-handoff';

import { READONLY_TOOLS, SHELL_TOOLS, extractTargets } from '../rails-checker.mjs';

/**
 * Tools the handoff deny-set applies to: everything that is not a known
 * read-only tool, shell included.
 *
 * Deliberately NOT honouring `ADLC_UNGATED_TOOLS` / `UNGATED_TOOLS`: those
 * exempt a tool from the RAIL check, which is a per-ticket path policy. The
 * deny-set is a session-level trust decision — a tool that cannot edit a rail
 * can still burn a rotted session's context — and the spec's only exits from it
 * are a signed resume-auth, a signed bypass, or host repair.
 *
 * @param {unknown} tool
 * @returns {boolean}
 */
export function handoffAppliesTo(tool) {
  const name = String(tool ?? '').toLowerCase();
  if (name === '') return false;
  return !READONLY_TOOLS.includes(name);
}

/** @param {unknown} tool */
export function isShellTool(tool) {
  return SHELL_TOOLS.includes(String(tool ?? '').toLowerCase());
}

/**
 * Every candidate target the deny-set should vet on a tool call.
 *
 * `extractTargets` is the rail checker's extractor and covers the shapes
 * OpenCode's OWN mutators use — `path`, `file`, `filePath`, `files[]`,
 * `edits[]`, apply_patch bodies. It does not read `target`/`targetPath`, which
 * third-party writers commonly use and which pi's equivalent extractor does
 * recognize, so a custom tool could name a protected artifact and reach the
 * handoff core with an empty path list.
 *
 * Widened here rather than in the rail checker: this is the deny-set's
 * always-on artifact protection, whereas extractTargets also drives per-ticket
 * rail policy whose behaviour is frozen. The rails-side gap is real but
 * separate.
 *
 * @param {object} args OpenCode tool args
 * @returns {string[]}
 */
export function handoffTargetsOf(args) {
  const out = new Set(extractTargets(args));
  for (const key of ['target', 'targetPath', 'target_path']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim() !== '') out.add(value);
  }
  return [...out];
}

/** Shell command text from OpenCode tool args. */
export function shellCommandOf(args) {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  return '';
}

/** Repo-relative, forward-slashed. Paths outside the repo keep their own form. */
export function toRepoRelative(path, root) {
  const normalized = String(path).replaceAll('\\', '/');
  const absolute = isAbsolute(normalized) ? normalized : resolve(root, normalized);
  const rel = relative(root, absolute).replaceAll('\\', '/');
  return rel.startsWith('..') ? normalized : rel;
}

/**
 * Per-session D1 memory. `processStickyDeny` is a per-call local inside the
 * gate, so a marker write that FAILED would deny one call and then fail open
 * once the band cooled. OpenCode runs in-process, so it can actually hold the
 * fact the spec asks callers to thread.
 */
export function createStickyDenyState() {
  const seen = new Set();
  return {
    /** @param {string|null} sessionId */
    has(sessionId) {
      return typeof sessionId === 'string' && seen.has(sessionId);
    },
    /** @param {string|null} sessionId @param {boolean} value */
    record(sessionId, value) {
      if (value === true && typeof sessionId === 'string' && sessionId !== '') {
        seen.add(sessionId);
      }
    },
  };
}

/**
 * Evaluate the handoff deny-set for one tool call.
 *
 * @param {object} opts
 * @param {unknown} opts.tool
 * @param {object} [opts.args] mutable tool args (output.args)
 * @param {string|undefined} opts.sessionID
 * @param {{ depth: (id: string) => number }} [opts.tracker]
 * @param {string} opts.root
 * @param {object} [opts.env] supplies ADLC_MANIFEST_KEY so a signed resume-auth
 *        can be VERIFIED — without it `authorized()` can never accept one
 * @param {ReturnType<typeof createStickyDenyState>} [opts.sticky]
 * @param {(o: object) => { deny: boolean, reasons: string[] }} [opts.evaluate]
 *        injection seam for tests; defaults to the package implementation
 * @returns {{ decision: 'allow'|'deny', reason?: string, reasons?: string[] }}
 */
export function checkHandoff({
  tool,
  args = {},
  sessionID,
  tracker,
  root,
  env = process.env,
  sticky,
  evaluate = evaluateHandoffPreToolUse,
}) {
  if (!handoffAppliesTo(tool)) return { decision: 'allow' };

  const shell = isShellTool(tool);
  const observed = {};
  if (tracker && typeof tracker.depth === 'function' && sessionID) {
    const depth = tracker.depth(sessionID);
    if (Number.isFinite(depth)) observed.depth = depth;
  }

  // An absent/blank sessionID is NOT an id: it must reach the gate as null so
  // the fail-closed-under-pressure path fires instead of silently passing.
  const sessionId = typeof sessionID === 'string' && sessionID !== '' ? sessionID : null;
  const manifestKey = env?.ADLC_MANIFEST_KEY;

  const result = evaluate({
    root,
    sessionId,
    observed,
    editRelPaths: shell ? [] : handoffTargetsOf(args).map((p) => toRepoRelative(p, root)),
    isBash: shell,
    bashCommand: shell ? shellCommandOf(args) : '',
    host: 'opencode',
    manifestKey: typeof manifestKey === 'string' && manifestKey !== '' ? manifestKey : null,
    denyEverWritten: sticky ? sticky.has(sessionId) : false,
  });
  if (sticky) sticky.record(sessionId, result.denyEverWritten);

  if (!result.deny) return { decision: 'allow' };
  return {
    decision: 'deny',
    reasons: result.reasons,
    reason:
      `context-rot handoff deny (${result.reasons.join(', ')}). Resume via host ` +
      '`adlc handoff resume` / repair, or continue in a fresh session. Agent shell ' +
      'cannot clear the deny-set.',
  };
}

export { isHandoffMutatingShell };
