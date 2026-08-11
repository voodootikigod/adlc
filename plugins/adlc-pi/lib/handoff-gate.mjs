// handoff-gate.mjs — pi's context-rot handoff deny (slice 5 of
// docs/specs/context-rot-handoff.md). pi is an ENFORCING tier: under the
// deny-set the agent loses structured edits AND the shell wholesale.
//
// D1-D3, the band thresholds, the protected-path list and the mutating-shell
// detector all come from `@adlc/context-handoff`; this module only maps pi's
// event shapes onto them.
//
// pi is the first adapter with a REAL context-fill percentage:
// `ctx.getContextUsage().percent` is a live 0-100 reading of the window, not a
// transcript-size proxy. It feeds the band join as `pct`; depth and bytes stay
// absent, and the OR-join ignores missing signal kinds rather than reading them
// as zero.
//
// Session identity: pi's own `ctx.sessionManager.getSessionId()`, which every
// ExtensionContext carries on its read-only session manager. The mint below is
// a last resort for contexts that expose no session manager at all (older
// hosts, harness fakes); it names the extension instance rather than the
// session, so it survives only as a fallback that still fails closed.

import { randomUUID } from 'node:crypto';
import { relative, isAbsolute, resolve } from 'node:path';

import {
  evaluateHandoffPreToolUse,
  isSafeSessionId,
  resolveHandoffSessionId,
} from '@adlc/context-handoff';
import { extractToolPaths } from './rails-checker.mjs';

/** pi tool names that mutate through a structured target. */
const STRUCTURED_MUTATORS = new Set(['write', 'edit']);
/** pi's shell tool. */
const SHELL_TOOLS = new Set(['bash']);

/**
 * A stable session id for this extension instance.
 *
 * Prefers whatever the host offers; falls back to a per-process mint. Returns
 * null when neither yields an id the deny store can safely name a file after —
 * the caller then fails closed under pressure rather than skipping the gate.
 *
 * @param {object} [event] pi session_start event
 * @param {object} [ctx] pi event context
 * @param {{ mint?: () => string }} [opts]
 * @returns {string|null}
 */
export function resolvePiSessionId(event, ctx, { mint = defaultMint } = {}) {
  // ctx.sessionManager.getSessionId() is pi's REAL session identity, exposed on
  // the read-only session manager every ExtensionContext carries. It must come
  // first: a minted id names the extension instance, not the session, so a
  // reload would hand the same rotten session a fresh identity and drop D2.
  let managed;
  try {
    managed =
      typeof ctx?.sessionManager?.getSessionId === 'function'
        ? ctx.sessionManager.getSessionId()
        : undefined;
  } catch {
    managed = undefined;
  }

  const hosted = resolveHandoffSessionId({
    candidates: [
      managed,
      event?.sessionId,
      event?.session_id,
      event?.session?.id,
      event?.id,
      ctx?.sessionId,
      ctx?.session?.id,
    ],
  });
  if (hosted) return hosted;
  const minted = mint();
  return isSafeSessionId(minted) ? minted : null;
}

function defaultMint() {
  return `pi-${process.pid}-${randomUUID()}`;
}

/**
 * Per-session D1 memory. `processStickyDeny` is a per-call local inside the
 * gate, so a marker write that FAILED would deny one call and then fail open
 * once the band cooled. pi runs in-process, so it can hold the fact the spec
 * asks callers to thread.
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

/** @param {unknown} toolName */
export function isStructuredMutator(toolName) {
  return STRUCTURED_MUTATORS.has(String(toolName ?? '').toLowerCase());
}

/** @param {unknown} toolName */
export function isShellTool(toolName) {
  return SHELL_TOOLS.has(String(toolName ?? '').toLowerCase());
}

/**
 * Tools the deny-set applies to: pi's structured mutators, its shell, and any
 * third-party tool the rail gate already treats as potentially mutating. A
 * custom tool with no extractable target is still gated — under an open deny
 * the session must stop, whatever it was about to call.
 *
 * @param {unknown} toolName
 * @param {string[]} [readOnlyTools] tool names known never to mutate
 * @returns {boolean}
 */
export function handoffAppliesTo(toolName, readOnlyTools = ['read', 'grep', 'glob', 'list', 'ls']) {
  const name = String(toolName ?? '').toLowerCase();
  if (name === '') return false;
  return !readOnlyTools.includes(name);
}

/** Structured edit target from a pi tool_call input, if any. */
export function editTargetOf(input) {
  const path = input?.path ?? input?.filePath ?? input?.file_path;
  return typeof path === 'string' && path.trim() !== '' ? path : null;
}

/**
 * Every extractable target from a tool_call input.
 *
 * The rail gate vets custom tools through `extractToolPaths`, which recognizes
 * `target` and `file` as well as `path`, plus one level of nesting. The handoff
 * gate read only the three `path` spellings, so a third-party tool calling
 * `{target: '.adlc/.deny-store'}` reached the deny store with an empty
 * editRelPaths while the rail checker saw the path perfectly well. One
 * extractor per plugin, not two.
 *
 * editTargetOf stays the narrow reader for pi's OWN structured mutators, whose
 * shape is known; this is the union so nothing extractable is dropped.
 *
 * @param {object} input pi tool_call input
 * @param {string} root repo root
 * @returns {string[]}
 */
export function editTargetsOf(input, root) {
  const out = new Set(extractToolPaths(input, root));
  const narrow = editTargetOf(input);
  if (narrow) out.add(narrow);
  return [...out];
}

/** Repo-relative, forward-slashed. Paths outside the repo keep their own form. */
export function toRepoRelative(path, root) {
  const normalized = String(path).replaceAll('\\', '/');
  const absolute = isAbsolute(normalized) ? normalized : resolve(root, normalized);
  const rel = relative(root, absolute).replaceAll('\\', '/');
  return rel.startsWith('..') ? normalized : rel;
}

/**
 * Observed band signals from pi's live context usage. Thresholds live in
 * `@adlc/context-handoff`; nothing here compares against one.
 *
 * A usage object that is present but carries a non-numeric percent is reported
 * as NaN, which the band classifier treats as invalid (fail closed) rather than
 * as a healthy zero. An ABSENT usage object contributes no signal at all — pi
 * degrades `getContextUsage()` to null on hosts that do not provide it, and a
 * missing telemetry source must not hard-lock the repo.
 *
 * @param {{ percent?: unknown }|null|undefined} usage
 * @returns {{ pct?: number }}
 */
export function observeHandoffSignals(usage) {
  if (usage === null || usage === undefined) return {};
  const percent = usage.percent;
  if (percent === null || percent === undefined) return {};
  const asNumber = Number(percent);
  return { pct: Number.isFinite(asNumber) ? asNumber : Number.NaN };
}

/**
 * Evaluate the handoff deny-set for one pi tool call.
 *
 * @param {object} opts
 * @param {unknown} opts.toolName
 * @param {object} [opts.input] pi tool_call input
 * @param {string|null} opts.sessionId
 * @param {object|null} [opts.usage] ctx.getContextUsage() reading
 * @param {string|null} [opts.ticketId]
 * @param {string} opts.root
 * @param {string|null} [opts.manifestKey] lets a signed resume-auth be VERIFIED;
 *        without it `authorized()` can never accept one, so a completed
 *        `adlc handoff resume` could not clear the deny it was minted to clear
 * @param {{ has: Function, record: Function }} [opts.sticky] per-session D1
 *        memory: a marker write that FAILED must stay sticky after the band
 *        cools, and only a caller with memory across calls can carry that
 * @param {Function} [opts.evaluate] injection seam for tests
 * @returns {{ decision: 'allow'|'deny', reason?: string, reasons?: string[] }}
 */
export function checkHandoff({
  toolName,
  input = {},
  sessionId,
  usage = null,
  ticketId = null,
  root,
  manifestKey = null,
  sticky,
  evaluate = evaluateHandoffPreToolUse,
}) {
  if (!handoffAppliesTo(toolName)) return { decision: 'allow' };

  const shell = isShellTool(toolName);
  const targets = shell ? [] : editTargetsOf(input, root);
  const safeSessionId = isSafeSessionId(sessionId) ? sessionId : null;

  const result = evaluate({
    root,
    sessionId: safeSessionId,
    observed: observeHandoffSignals(usage),
    ticketId,
    editRelPaths: targets.map((p) => toRepoRelative(p, root)),
    isBash: shell,
    bashCommand: shell && typeof input?.command === 'string' ? input.command : '',
    host: 'pi',
    manifestKey: typeof manifestKey === 'string' && manifestKey !== '' ? manifestKey : null,
    denyEverWritten: sticky ? sticky.has(safeSessionId) : false,
  });
  if (sticky) sticky.record(safeSessionId, result.denyEverWritten);

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
