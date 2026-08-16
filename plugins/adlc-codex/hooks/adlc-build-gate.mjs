#!/usr/bin/env node
// adlc-build-gate.mjs — Codex port of Claude Code's context-fitness build
// gate (T49). See .adlc/specs/codex-build-gate.md for the full design.
//
// KEEP IN SYNC — deriveRiskSignals/computeRiskTier are a verbatim inline copy
// of packages/build-gate/lib/risk.mjs, and countToolCalls/computeDepthSignal/
// isDegraded are a verbatim inline copy of packages/build-gate/lib/
// depth-signal.mjs. A PreToolUse hook runs from the plugin's INSTALLED
// location, which has no node_modules, so it cannot resolve npm package
// dependencies at runtime — the same reason adlc-rails-guard.mjs inline-
// copies @adlc/core/lib/shell.mjs's shell classifier instead of importing it.
// A drift test (hooks/test/build-gate.test.mjs) pins this copy against the
// real packages/build-gate exports.
//
// Active-ticket resolution goes through the canonical pointer contract
// (generated-active-ticket.mjs, generated from packages/tickets/lib/pointer.mjs)
// via the same pattern adlc-rails-guard.mjs uses — not a hand-rolled parse.
// scripts/test/ticket-store-boundary.test.mjs enforces that the pointer has
// exactly one reader across the whole repo.

import { existsSync, readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadTicketStoreReadOnly, ticketStoreExists } from './generated-ticket-reader.mjs';
import { resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';
import {
  isRecoveryEligibleToolName,
  isBareInspectionPwd,
  matchRecoveryCommand,
  resolveTrustedBinary,
  recordRecoveryUnderBand,
  collectCommandText,
  toolNameOf,
  resolveHandoffSessionIdLocal,
} from './adlc-handoff-gate.mjs';
import { resolveContextHandoffEntry } from './handoff-resolve.mjs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  console.error(`adlc-build-gate: ${message}`);
  process.exit(2);
}

async function stdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

// Enforcing gate: a malformed/conflicting pointer fails closed, matching
// adlc-rails-guard.mjs's resolveActiveTicketId().
function resolveActiveTicketId() {
  const resolved = resolveActiveTicketIdCanonical({ root: process.cwd(), env: process.env });
  if (!resolved.ok) fail(resolved.message);
  return { id: resolved.value?.id ?? undefined };
}

// ---------------------------------------------------------------------------
// KEEP IN SYNC with packages/build-gate/lib/risk.mjs.
// ---------------------------------------------------------------------------

const TRUST_ROOT_PATHS = ['.adlc/tickets.json', '.adlc/tickets/**', '.adlc/current-ticket.json'];
const MANIFEST_PATH = '.adlc/manifest.jsonl';
const HIGH_RISK_CATEGORIES = new Set(['contract', 'architecture']);

// The rail/scope glob matcher is a GENERATED verbatim copy of
// packages/core/lib/glob.mjs: this file is installed without node_modules, so it
// cannot import @adlc/core, and a hand-kept copy is what drifted before.
import { globMatch } from './generated-glob-match.mjs';

export { globMatch };

function touchesAny(globs, paths) {
  return (globs ?? []).some((g) => paths.some((p) => g === p || globMatch(g, p)));
}

export function deriveRiskSignals(ticket) {
  const t = ticket ?? {};
  const signals = [];
  if (t.risk === 'high') signals.push('declared-risk-high');
  if (t.external === true) signals.push('external-system-effect');
  if (t.mutatesIdentity === true) signals.push('mutates-identity');
  if (t.scope !== undefined && !Array.isArray(t.scope)) signals.push('malformed-scope');
  if (t.rails !== undefined && !Array.isArray(t.rails)) signals.push('malformed-rails');
  const combinedGlobs = [
    ...(Array.isArray(t.scope) ? t.scope : []),
    ...(Array.isArray(t.rails) ? t.rails : []),
  ];
  if (touchesAny(combinedGlobs, [MANIFEST_PATH])) signals.push('mutates-manifest');
  if (touchesAny(combinedGlobs, TRUST_ROOT_PATHS)) signals.push('touches-trust-root');
  if (HIGH_RISK_CATEGORIES.has(t.category)) signals.push(`high-risk-category:${t.category}`);
  return signals;
}

export function computeRiskTier(ticket) {
  const signals = deriveRiskSignals(ticket);
  return { tier: signals.length > 0 ? 'high' : 'normal', signals };
}

// ---------------------------------------------------------------------------
// KEEP IN SYNC with packages/build-gate/lib/depth-signal.mjs, comparison
// logic only. packages/build-gate/lib/depth-signal.mjs's own
// DEFAULT_BYTES_THRESHOLD currently equals HARD_BYTES (256 KiB); this
// file's DEFAULT_BYTES_THRESHOLD is 8 MiB. The two values are not equal.
// ---------------------------------------------------------------------------

export const DEFAULT_DEPTH_THRESHOLD = 40;
/**
 * Transcript byte count at which a session is considered context-degraded.
 * A raw byte count alone does not indicate tool-call depth: system-prompt
 * and schema content contributes bytes independent of any tool call, so a
 * threshold near the low end of ordinary session sizes classifies sessions
 * with zero tool calls as degraded. 8 MiB is the SAME ceiling
 * `@adlc/context-handoff`'s MAX_ACTIVE_CONTEXT_BYTES uses for its own scan
 * budget.
 */
export const DEFAULT_BYTES_THRESHOLD = 8 * 1024 * 1024;
/**
 * The tail window `decide()` scans to compute tool-call depth. Must be at
 * least DEFAULT_BYTES_THRESHOLD: a smaller window can, for a transcript
 * sized between this constant and DEFAULT_BYTES_THRESHOLD, both (a)
 * truncate away tool calls that occurred earlier than the window and (b)
 * leave the byte-based signal below threshold — the two signals no longer
 * jointly cover that size range, and depth is undercounted.
 */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

export function countToolCalls(text) {
  if (!text) return 0;
  const toolUseBlocks = text.match(/"type"\s*:\s*"tool_use"/g) ?? [];
  const proseToolLines = text.match(/^(?:Writing|Editing|Created)\s+\S+/gim) ?? [];
  return toolUseBlocks.length + proseToolLines.length;
}

export function computeDepthSignal({ text, bytes } = {}) {
  const toolCallCount = countToolCalls(text ?? '');
  const resolvedBytes = typeof bytes === 'number' ? bytes : Buffer.byteLength(text ?? '', 'utf8');
  return { bytes: resolvedBytes, toolCallCount, depth: toolCallCount };
}

export function isDegraded({ depth, sessionBytes, bytes, depthThreshold = DEFAULT_DEPTH_THRESHOLD, bytesThreshold = DEFAULT_BYTES_THRESHOLD }) {
  // Inclusive >= — comparison logic tracks packages/build-gate/lib/depth-signal.mjs;
  // see DEFAULT_BYTES_THRESHOLD's comment for the deliberate default-value divergence.
  const resolvedBytes = typeof sessionBytes === 'number' ? sessionBytes : bytes;
  const depthDegraded = typeof depth === 'number' && depth >= depthThreshold;
  const bytesDegraded = typeof resolvedBytes === 'number' && resolvedBytes >= bytesThreshold;
  return depthDegraded || bytesDegraded;
}

// ---------------------------------------------------------------------------
// Transcript windowing — KEEP IN SYNC with plugins/adlc-claude-code/hooks/
// adlc-hook.mjs's fileSize()/tailBytes() (same O(MAX_SCAN_BYTES) technique).
// ---------------------------------------------------------------------------

function fileSize(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    return fstatSync(fd).size;
  } catch {
    return -1;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

function tailBytes(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0 && nl + 1 < text.length) text = text.slice(nl + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------
// Bypass recording — shells to the globally-installed `adlc` binary, exactly
// like Claude Code's recordBuildGateBypass, so manifest entries stay
// harness-agnostic (same gate name: build-gate-bypass).
// ---------------------------------------------------------------------------

export function recordBuildGateBypass(ticketId, signals, depth, sessionBytes, { cwd } = {}) {
  const result = spawnSync('adlc', [
    'gate-manifest', 'record', 'build-gate-bypass',
    '--ticket', ticketId,
    '--data', JSON.stringify({ signals, depth, sessionBytes }),
  ], { encoding: 'utf8', ...(cwd ? { cwd } : {}) });
  return !!result && result.status === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function decide({ ticket, transcriptPath, bypassRequested }) {
  const { tier, signals } = computeRiskTier(ticket);
  if (tier !== 'high') return { decision: 'allow', reason: `ticket risk tier is '${tier}'` };

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { decision: 'deny', reason: `active ticket is high-risk (${signals.join(', ')}) but no readable transcript_path was supplied — the context-fitness signal cannot be verified, failing closed` };
  }

  const sessionBytes = fileSize(transcriptPath);
  if (sessionBytes < 0) {
    return { decision: 'deny', reason: `active ticket is high-risk (${signals.join(', ')}) but transcript_path could not be read — the context-fitness signal cannot be verified, failing closed` };
  }

  const windowText = sessionBytes > MAX_SCAN_BYTES ? tailBytes(transcriptPath, MAX_SCAN_BYTES) : readOptionalTranscript(transcriptPath);
  if (windowText == null) {
    return { decision: 'deny', reason: `active ticket is high-risk (${signals.join(', ')}) but the transcript window could not be read — the context-fitness signal cannot be verified, failing closed` };
  }

  const depth = countToolCalls(windowText);
  const degraded = isDegraded({ depth, sessionBytes });
  if (!degraded) return { decision: 'allow', reason: 'high-risk ticket, but the context-fitness signal is not degraded' };

  if (bypassRequested) {
    return { decision: 'pending-bypass', signals, depth, sessionBytes };
  }

  return {
    decision: 'deny',
    reason:
      `active ticket is high-risk (${signals.join(', ')}) and this session's context-fitness signal is past ` +
      `threshold (depth=${depth}, sessionBytes=${sessionBytes}). Resume in a FRESH session (or an isolated ` +
      'subagent) rather than continuing here. To override deliberately, set ADLC_BUILD_GATE_BYPASS=1 (the bypass is recorded to the gate-manifest).',
  };
}

function readOptionalTranscript(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

async function main() {
  if (!existsSync('.adlc')) process.exit(0); // not an ADLC repo → allow
  if (!ticketStoreExists(process.cwd(), process.env)) process.exit(0); // no tickets → nothing to gate → allow

  const payload = await stdinJson();

  // Recovery Exception & Inspection Bash Exception (context-rot-threshold-
  // calibration spec §1.3), applied to THIS gate too — evaluated before any
  // of build-gate's own high-risk/degraded-context deny logic below. This
  // gate runs BEFORE adlc-handoff-gate.mjs in hooks.json's PreToolUse
  // pipeline for every shell tool identity; without this check, a session
  // working a high-risk ticket with a >256 KiB transcript would have `pwd`
  // and the recovery CLI denied HERE, before the handoff gate's own,
  // otherwise-unconditional exception ever got a chance to run — the exact
  // total-lockout bug this whole hotfix exists to close, reached through a
  // sibling gate instead of the handoff gate itself. Reuses the same
  // trusted, package-independent matcher as the handoff gate (imported from
  // the sibling adlc-handoff-gate.mjs — a plugin-owned, trusted file, never
  // the dynamically-loaded project-resolved package) so both gates share one
  // definition of what an authorized recovery/inspection command is. Unlike
  // the handoff gate, this file never imports untrusted project-resolved
  // code at all (it's a fully self-contained inline copy, per its own header
  // comment), so there's no NODE_OPTIONS/PATH-poisoning window to guard
  // against here — the audit spawn can use process.env directly.
  const name = toolNameOf(payload);
  if (isRecoveryEligibleToolName(name)) {
    const candidates = collectCommandText(payload).filter((c) => typeof c === 'string' && c.length > 0);
    if (candidates.length === 1) {
      const [candidateCommand] = candidates;
      if (isBareInspectionPwd(candidateCommand)) process.exit(0); // unconditional allow, no audit record
      // Resolution walks the PROJECT's own node_modules, the same way
      // loadContextHandoff does elsewhere — this does not import/execute
      // the package, only locates it, but a repository that ships its own
      // @adlc/context-handoff controls what path this resolves to (see
      // adlc-handoff-gate.mjs's identical comment for the full residual).
      const entry = resolveContextHandoffEntry({ projectRoot: process.cwd() });
      const trustedRecoveryCliPath = entry ? join(dirname(dirname(entry)), 'bin', 'handoff.mjs') : null;
      if (trustedRecoveryCliPath) {
        const sessionId = resolveHandoffSessionIdLocal({
          candidates: [payload.session_id, payload.sessionId],
          transcriptPath: payload.transcript_path,
        });
        const recoveryMatch = matchRecoveryCommand(candidateCommand, {
          interpreterPath: process.execPath,
          scriptPath: trustedRecoveryCliPath,
          sessionId,
        });
        if (recoveryMatch.matched) {
          recordRecoveryUnderBand({
            subcommand: recoveryMatch.subcommand,
            sessionId,
            trustedEnv: process.env,
            adlcBinPath: resolveTrustedBinary('adlc', process.env.PATH),
          });
          process.exit(0); // allow — never gated on the audit record above succeeding
        }
      }
    }
  }

  const active = resolveActiveTicketId();
  if (!active.id) process.exit(0); // no active ticket declared → allow (opt-in gate)

  let ticket;
  try {
    ticket = loadTicketStoreReadOnly({ root: process.cwd(), env: process.env }).tickets.find((t) => t.id === active.id);
  } catch (e) {
    fail(`cannot read the ticket store (${e.message}) — active ticket ${active.id}'s risk cannot be verified, failing closed`);
  }
  if (!ticket) fail(`active ticket ${active.id} not found in the ticket store — failing closed`);

  const bypassRequested = process.env.ADLC_BUILD_GATE_BYPASS === '1';
  const result = decide({ ticket, transcriptPath: payload.transcript_path, bypassRequested });

  if (result.decision === 'allow') process.exit(0);
  if (result.decision === 'pending-bypass') {
    if (recordBuildGateBypass(active.id, result.signals, result.depth, result.sessionBytes)) process.exit(0); // audited → allow
    fail('ADLC_BUILD_GATE_BYPASS is set but the override could not be recorded to the gate-manifest (is @adlc/cli installed and .adlc writable?). An unaudited bypass is refused — the build is blocked.');
  }
  fail(result.reason);
}

// Only run as a hook when executed directly (`node adlc-build-gate.mjs`), not
// when imported — the drift test imports this module for its pure exports
// (computeRiskTier, decide, ...) and must not trigger a live stdin read.
//
// pathToFileURL, never `file://${argv[1]}`: Node percent-encodes
// import.meta.url (a space becomes %20) but a manually built template
// string does not, so ANY install path containing a space (or other
// percent-encoded character) made this comparison always false — main()
// silently never ran and the hook exited 0 (allow) unconditionally,
// regardless of ticket risk or session degradation (Round-5 review).
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    // Enforcing hook — a crash must fail closed, never fall through to allow.
    fail(`build-gate hook errored (${err?.message ?? 'unknown'}) — failing closed`);
  });
}
