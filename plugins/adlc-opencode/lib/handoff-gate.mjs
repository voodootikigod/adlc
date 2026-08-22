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

import { existsSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';

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
 * The value grammar a session id must satisfy before it can be interpolated
 * into the copy-pasteable recovery command below. Same conservative set as the
 * codex hook's twin (RECOVERY_VALUE_RE): no whitespace, no quotes, no shell
 * metacharacters, so a host-supplied id can never smuggle a second command into
 * a string an operator is being invited to paste into a shell.
 */
const RECOVERY_VALUE_RE = /^[A-Za-z0-9_./=:-]+$/;

/**
 * The session that OWNS the open deny, which is not always the session being
 * denied. A D3 deny means someone else's marker is open — `mutation-gate.mjs`
 * reports it as `D3:unauthorized_open:<owner>` — and every recovery command
 * addresses the marker, so it must name the owner. Pointing `repair` at the
 * blocked session instead finds no marker and refuses.
 *
 * @param {string[]} reasons
 * @returns {string|null}
 */
export function denyOwnerOf(reasons) {
  const prefix = 'D3:unauthorized_open:';
  for (const reason of Array.isArray(reasons) ? reasons : []) {
    if (typeof reason === 'string' && reason.startsWith(prefix)) {
      return reason.slice(prefix.length);
    }
  }
  return null;
}

/**
 * The recovery tail every deny message carries: which session is denied, who
 * owns the deny, and the literal host-side commands that clear it. A deny with
 * none of that is what the release audit found — an agent told to "resume via
 * host" with no session id and no command, from inside a shell that is itself
 * denied.
 *
 * Built ENTIRELY from local code, deliberately: this is the codex hook's
 * round-5 reasoning (formatRecoveryCommand, adlc-handoff-gate.mjs) applied
 * here. The deny message is precisely what an operator reads when the handoff
 * machinery is misbehaving, so the diagnostic must not be rendered by the
 * machinery it is describing.
 *
 * The owner is held to the same value grammar as the session id, and for a
 * stronger reason: the session id comes from the host, but the owner is read
 * off a deny record on disk, so it is the less trusted of the two.
 *
 * @param {unknown} sessionId the session being denied
 * @param {string[]} [reasons] the gate's reason codes, source of the D3 owner
 * @returns {string}
 */
export function recoveryTail(sessionId, reasons = []) {
  const owner = denyOwnerOf(reasons);
  // A foreign deny whose owner cannot be safely quoted: name the marker
  // directory instead of emitting a command built from an id we do not trust.
  if (owner !== null && !RECOVERY_VALUE_RE.test(owner)) {
    return (
      'The open deny belongs to another session whose id cannot be printed as a safe, copy-pasteable ' +
      'shell command. Read the owning id from .adlc/handoffs/denies/ on the host and run `adlc handoff ' +
      'repair` against it. Read-only tools remain usable in the interim.'
    );
  }
  if (typeof sessionId !== 'string' || !RECOVERY_VALUE_RE.test(sessionId)) {
    // With no usable session id there is still a recoverable marker whenever
    // the deny is foreign, so the owner's command is worth printing alone.
    if (owner !== null) {
      return (
        `The open deny belongs to session ${owner}; this session has no safe id of its own. Recover from ` +
        `a HOST shell: \`adlc handoff repair --session ${owner} --ticket <id> --content-hash <hash> ` +
        `--write\`, then \`adlc handoff resume --session <new-session> --deny-session ${owner} --write\`.`
      );
    }
    return (
      'No safe session id could be resolved for this session, so no session-specific recovery command ' +
      'can be printed. End this session and start a new one — the host mints a fresh session id, ' +
      'unaffected by this resolution failure. Read-only tools remain usable in the interim.'
    );
  }
  // Self-deny (the depth band wrote this session's own marker) vs foreign deny.
  const target = owner ?? sessionId;
  const whose =
    target === sessionId
      ? `Denied session id: ${sessionId}.`
      : `Denied session id: ${sessionId}; the open deny belongs to session ${target}.`;
  return (
    `${whose} Recover from a HOST shell (the agent shell is inside the deny-set): ` +
    `\`adlc handoff repair --session ${target} --ticket <id> --content-hash <hash> --write\` binds the ` +
    `open deny, then \`adlc handoff resume --session <new-session> --deny-session ${target} --write\` ` +
    'from the successor session.'
  );
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
 * @param {string|null|(() => string|null)} [opts.ticketId] the ticket the deny
 *        marker is bound to. May be a thunk: resolving it reads the ticket
 *        pointer, and the read-only hot path must not pay for a marker it will
 *        never write.
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
  ticketId = null,
  sticky,
  evaluate = evaluateHandoffPreToolUse,
}) {
  // Containment, before anything else can evaluate or write: the deny-set has
  // no jurisdiction over a directory that never opted into ADLC. Without this
  // the depth band denied tool call 30 and every call after it in an ordinary
  // repo, and CREATED .adlc/.deny-store plus .adlc/handoffs/denies/<id>.json
  // there. Same guard both sibling enforcing adapters apply
  // (plugins/adlc-codex/hooks/adlc-handoff-gate.mjs, plugins/adlc-claude-code/
  // hooks/adlc-hook.mjs).
  //
  // Checked against the caller's `root` — the value every other path in this
  // gate resolves against — never a re-derived cwd, or the guard and the writes
  // it is guarding could disagree about which repo is in play. A root that is
  // not a usable string is NOT containment: it means the caller is broken, and
  // that falls through to the evaluation path (which fails closed) rather than
  // buying an allow.
  if (typeof root === 'string' && root !== '' && !existsSync(join(root, '.adlc'))) {
    return { decision: 'allow' };
  }
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

  // Resolved here, past both guards, so the thunk form costs nothing on the
  // calls that never reach the gate. An unbound marker (ticket_id:null) is one
  // `adlc handoff repair`/`resume` refuses — the deny is written but the
  // operator has no way to clear it.
  const resolvedTicketId = typeof ticketId === 'function' ? ticketId() : ticketId;

  const result = evaluate({
    root,
    sessionId,
    observed,
    ticketId:
      typeof resolvedTicketId === 'string' && resolvedTicketId !== '' ? resolvedTicketId : null,
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
      `cannot clear the deny-set.\n\n${recoveryTail(sessionId, result.reasons)}`,
  };
}

export { isHandoffMutatingShell };
