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
// Session identity: pi runs the extension in-process and does not hand out a
// session id, so one is taken from the session_start event when the host
// supplies it and otherwise minted per extension instance. A minted id is
// stable for the process — which is exactly the lifetime D2 (denier sticky)
// needs — while a NEW process gets a new id and is held by D3 against the
// previous session's still-open record.

import { randomUUID } from 'node:crypto';
import { relative, isAbsolute, resolve } from 'node:path';

import {
  evaluateHandoffPreToolUse,
  isSafeSessionId,
  resolveHandoffSessionId,
} from '@adlc/context-handoff';

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
  const hosted = resolveHandoffSessionId({
    candidates: [
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
  evaluate = evaluateHandoffPreToolUse,
}) {
  if (!handoffAppliesTo(toolName)) return { decision: 'allow' };

  const shell = isShellTool(toolName);
  const target = shell ? null : editTargetOf(input);

  const result = evaluate({
    root,
    sessionId: isSafeSessionId(sessionId) ? sessionId : null,
    observed: observeHandoffSignals(usage),
    ticketId,
    editRelPaths: target ? [toRepoRelative(target, root)] : [],
    isBash: shell,
    bashCommand: shell && typeof input?.command === 'string' ? input.command : '',
    host: 'pi',
  });

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
