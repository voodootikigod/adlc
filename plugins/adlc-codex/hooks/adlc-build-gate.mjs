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

import { existsSync, readFileSync, openSync, fstatSync, readSync, closeSync, realpathSync } from 'node:fs';
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
  RECOVERY_AUDIT_ENV_ALLOWLIST,
  repoManifestChainIsSigned,
} from './adlc-handoff-gate.mjs';
import { resolveContextHandoffEntry } from './handoff-resolve.mjs';
import {
  canonicalizePath,
  extractAllToolWorkdirs,
  findInnermostCheckoutRoot,
  inspectGitCheckout,
  isPathInside,
  preferInnermostCheckout,
} from './generated-workspace-root.mjs';
import { isAbsolute, join, dirname, relative, resolve } from 'node:path';
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
function resolveActiveTicketId(root = process.cwd(), env = process.env) {
  const resolved = resolveActiveTicketIdCanonical({ root, env });
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

/**
 * KEEP IN SYNC with packages/build-gate/lib/depth-signal.mjs's countToolCalls().
 * The five `*_call` tags are the COMPLETE set of Codex rollout `response_item`
 * call records, enumerated across every rollout on disk; the closing quote is
 * what keeps the `_output` result half of each pair from doubling the count.
 * Full rationale — including which event_msg mirrors are deliberately
 * excluded — lives on the canonical copy.
 */
export function countToolCalls(text) {
  if (!text) return 0;
  const toolCallRecords =
    text.match(/"type"\s*:\s*"(?:tool_use|function_call|custom_tool_call|web_search_call|tool_search_call|image_generation_call)"/g) ?? [];
  const proseToolLines = text.match(/^[ \t]*(?:\[?(?:\d{4}-\d{2}-\d{2}[T ])?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?[ \t]+)?(?:Writing|Editing|Created)[ \t]+\S+/gim) ?? [];
  return toolCallRecords.length + proseToolLines.length;
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
//
// Resolved via resolveTrustedBinary (never a bare `spawnSync('adlc', ...)`
// PATH lookup) and invoked via process.execPath with an env built from
// RECOVERY_AUDIT_ENV_ALLOWLIST only — the same threat model and mechanism
// adlc-handoff-gate.mjs's recordRecoveryUnderBand already uses: a repository
// can plant `node_modules/.bin/adlc` ahead of a real install, and the
// resolved binary's provenance cannot be fully verified, so its child must
// never see ADLC_MANIFEST_KEY/ADLC_ADMIN_KEY or anything else outside the
// allowlist (#807).
// ---------------------------------------------------------------------------

// A recorder that never exits is killed after this long. The killed child has
// no exit status, so the bypass counts as unrecorded and the gate denies —
// promptly, instead of holding the tool call until the host gives up.
const BYPASS_RECORD_TIMEOUT_MS = 5000;

export function recordBuildGateBypass(ticketId, signals, depth, sessionBytes, { cwd } = {}) {
  // The child never receives a signing key, and an unsigned entry after a
  // signed one corrupts the chain, so a signed chain leaves the bypass
  // unrecorded and the gate denies.
  if (repoManifestChainIsSigned(cwd ?? process.cwd())) return false;
  const adlcBinPath = resolveTrustedBinary('adlc', process.env.PATH);
  if (!adlcBinPath) return false;
  // A real global install (`npm i -g @adlc/cli`) links an EXTENSIONLESS bin name
  // to a `.mjs` target — Node's module-type detection for a `node <path>` entry
  // point is version-dependent for an extensionless path (older Node defaults to
  // CommonJS and fails an `import` statement; newer Node auto-detects). Resolve
  // the trust-verified candidate to its real, extensioned path before invoking
  // it so the spawned script's module type is unambiguous on every supported
  // Node version — a pure robustness step, not a trust decision (that already
  // happened in resolveTrustedBinary above).
  let resolvedBinPath = adlcBinPath;
  try { resolvedBinPath = realpathSync(adlcBinPath); } catch { /* fall back to the candidate as-is */ }
  const env = {};
  for (const name of RECOVERY_AUDIT_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const args = [
    resolvedBinPath,
    'gate-manifest', 'record', 'build-gate-bypass',
    '--ticket', ticketId,
    '--data', JSON.stringify({ signals, depth, sessionBytes }),
  ];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env,
    timeout: BYPASS_RECORD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...(cwd ? { cwd } : {}),
  });
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

function collectPatchHeaderPaths(text, baseDir, out) {
  for (const line of String(text).split(/\r?\n/)) {
    for (const prefix of ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: ']) {
      if (line.startsWith(prefix)) {
        const p = line.slice(prefix.length).trim();
        if (p) out.push(resolve(baseDir, p));
      }
    }
  }
}

function collectDynamicTargets(value, baseDir, rootPayload = value, out = [], seen = new Set()) {
  if (!value) return out;
  if (typeof value === 'string') {
    collectPatchHeaderPaths(value, baseDir, out);
    return out;
  }
  if (typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectDynamicTargets(item, baseDir, rootPayload, out, seen);
    return out;
  }
  const stripped =
    value === rootPayload ? (({ cwd: _envelopeCwd, ...rest }) => rest)(value) : value;
  for (const wd of extractAllToolWorkdirs(stripped)) {
    out.push(resolve(baseDir, wd));
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      ['path', 'filePath', 'file_path', 'target', 'targetPath', 'target_path'].includes(key) &&
      typeof child === 'string' &&
      child.trim()
    ) {
      out.push(resolve(baseDir, child.trim()));
    } else if (['paths', 'filePaths', 'file_paths'].includes(key) && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === 'string' && item.trim()) out.push(resolve(baseDir, item.trim()));
        else collectDynamicTargets(item, baseDir, rootPayload, out, seen);
      }
    } else if (['command', 'cmd', 'patch', 'input'].includes(key) && typeof child === 'string') {
      collectPatchHeaderPaths(child, baseDir, out);
    } else if (child && typeof child === 'object') {
      collectDynamicTargets(child, baseDir, rootPayload, out, seen);
    }
  }
  return out;
}

function hasLocalDefaultTicketStore(dir) {
  return (
    existsSync(join(dir, '.adlc', 'tickets', '.store.json')) ||
    existsSync(join(dir, '.adlc', 'tickets.json'))
  );
}

function sanitizeDiscoveryStoreOverride(rawOverride, startDir, baseCwd = startDir) {
  if (typeof rawOverride !== 'string' || !rawOverride.trim()) return null;
  const trimmed = rawOverride.trim();
  const resolvedStart = resolve(startDir);
  const boundary = findInnermostCheckoutRoot(resolvedStart, {
    storeOverride: null,
    requireStore: false,
    allowFileStart: true,
    preserveSpelling: true,
  });
  const anchor = boundary ?? resolvedStart;
  const anchorInfo = inspectGitCheckout(canonicalizePath(anchor));
  const anchorParent = dirname(resolve(anchor));
  const enclosing =
    anchorParent !== resolve(anchor)
      ? findInnermostCheckoutRoot(anchorParent, {
          storeOverride: null,
          requireStore: true,
          preserveSpelling: true,
        })
      : null;
  if (isAbsolute(trimmed)) {
    if (enclosing && isPathInside(trimmed, enclosing) && !isPathInside(trimmed, anchor)) {
      return null;
    }
    if ((anchorInfo?.kind === 'worktree' || enclosing) && hasLocalDefaultTicketStore(anchor) && !isPathInside(trimmed, anchor)) {
      return null;
    }
    return trimmed;
  }
  const lexRel = relative('/anchor', resolve('/anchor', trimmed));
  const escapesLexically =
    lexRel === '..' || lexRel.startsWith('../') || lexRel.startsWith('..\\') || isAbsolute(lexRel);
  if (escapesLexically) {
    if (boundary && baseCwd) {
      const resolvedBase = resolve(baseCwd);
      if (isPathInside(resolvedBase, boundary)) {
        const fromBase = resolve(resolvedBase, trimmed);
        if (isPathInside(fromBase, boundary) && existsSync(fromBase)) {
          return fromBase;
        }
      }
    }
    return null;
  }
  if (boundary) {
    return isPathInside(resolve(boundary, trimmed), boundary) ? trimmed : null;
  }
  const atStart = resolve(resolvedStart, trimmed);
  if (existsSync(atStart) && !isPathInside(atStart, resolvedStart)) return null;
  return trimmed;
}

function envForCheckout(checkoutRoot, outerRoot, baseEnv = process.env) {
  const next = { ...baseEnv };
  const sameAsPrimary = canonicalizePath(resolve(checkoutRoot)) === canonicalizePath(resolve(outerRoot));
  const checkoutInfo = inspectGitCheckout(canonicalizePath(resolve(checkoutRoot)));
  const parentDir = dirname(resolve(checkoutRoot));
  const enclosingCheckout =
    parentDir !== resolve(checkoutRoot)
      ? findInnermostCheckoutRoot(parentDir, {
          storeOverride: null,
          requireStore: true,
          preserveSpelling: true,
        })
      : null;
  const isNestedWorktree = checkoutInfo?.kind === 'worktree' || enclosingCheckout !== null;
  const localStorePresent = hasLocalDefaultTicketStore(checkoutRoot);
  if (sameAsPrimary && !isNestedWorktree) {
    for (const key of ['ADLC_TICKET_STORE', 'ADLC_TICKETS']) {
      const val = next[key];
      if (typeof val !== 'string' || !val.trim()) continue;
      const trimmed = val.trim();
      if (isAbsolute(trimmed)) continue;
      const fromCheckout = resolve(checkoutRoot, trimmed);
      if (isPathInside(fromCheckout, checkoutRoot)) {
        if (
          !existsSync(fromCheckout) &&
          isPathInside(process.cwd(), checkoutRoot) &&
          isPathInside(resolve(process.cwd(), trimmed), checkoutRoot) &&
          existsSync(resolve(process.cwd(), trimmed))
        ) {
          next[key] = resolve(process.cwd(), trimmed);
        }
        continue;
      }
      if (
        isPathInside(process.cwd(), checkoutRoot) &&
        isPathInside(resolve(process.cwd(), trimmed), checkoutRoot) &&
        existsSync(resolve(process.cwd(), trimmed))
      ) {
        next[key] = resolve(process.cwd(), trimmed);
      } else if (localStorePresent) {
        delete next[key];
      }
    }
    return next;
  }
  if (!sameAsPrimary && (!isPathInside(checkoutRoot, outerRoot) || existsSync(join(checkoutRoot, '.adlc', 'current-ticket.json')))) {
    delete next.ADLC_TICKET;
  }
  for (const key of ['ADLC_TICKET_STORE', 'ADLC_TICKETS']) {
    const val = next[key];
    if (typeof val !== 'string' || !val.trim()) continue;
    const trimmed = val.trim();
    const resolvedRel = resolve(checkoutRoot, trimmed);
    const keepRelative =
      !isAbsolute(trimmed) && isPathInside(resolvedRel, checkoutRoot) && existsSync(resolvedRel);
    const fromBaseCwd =
      sameAsPrimary &&
      !isAbsolute(trimmed) &&
      isPathInside(process.cwd(), checkoutRoot) &&
      isPathInside(resolve(process.cwd(), trimmed), checkoutRoot) &&
      existsSync(resolve(process.cwd(), trimmed))
        ? resolve(process.cwd(), trimmed)
        : null;
    if (fromBaseCwd) {
      next[key] = fromBaseCwd;
      continue;
    }
    const outsideOuter =
      (sameAsPrimary || !isPathInside(trimmed, outerRoot)) &&
      (!enclosingCheckout || !isPathInside(trimmed, enclosingCheckout) || isPathInside(trimmed, checkoutRoot));
    const keepExternal =
      isAbsolute(trimmed) &&
      outsideOuter &&
      !localStorePresent;
    if (!keepRelative && !keepExternal) {
      delete next[key];
    }
  }
  return next;
}

function resolveCandidateBuildGateRoots(outerRoot, dynamicPaths, storeOverride) {
  const roots = new Set();
  if (dynamicPaths.length === 0) {
    roots.add(outerRoot);
    return [...roots];
  }
  const nestedProbeStoreOverride =
    storeOverride &&
    ((!isAbsolute(storeOverride) &&
      (!isPathInside(resolve(outerRoot, storeOverride), outerRoot) ||
        !existsSync(resolve(outerRoot, storeOverride)))) ||
      (isAbsolute(storeOverride) && isPathInside(storeOverride, outerRoot)))
      ? null
      : storeOverride;
  const foreignStoreOverride =
    storeOverride && isAbsolute(storeOverride) && !isPathInside(storeOverride, outerRoot)
      ? storeOverride
      : null;
  let anyOutsideNestedWorktree = false;
  for (const absTarget of dynamicPaths) {
    if (isPathInside(absTarget, outerRoot)) {
      const inner =
        preferInnermostCheckout(outerRoot, [absTarget], {
          storeOverride: nestedProbeStoreOverride,
          allowFileStart: true,
          preserveSpelling: true,
        }) ?? outerRoot;
      roots.add(inner);
      if (inner === outerRoot) anyOutsideNestedWorktree = true;
    } else {
      anyOutsideNestedWorktree = true;
      const foreign = findInnermostCheckoutRoot(absTarget, {
        storeOverride: foreignStoreOverride,
        allowFileStart: true,
        requireStore: true,
        preserveSpelling: true,
      });
      if (foreign) roots.add(foreign);
    }
  }
  if (anyOutsideNestedWorktree) roots.add(outerRoot);
  return [...roots];
}

async function main() {
  const payload = await stdinJson();
  const toolCwd =
    typeof payload?.cwd === 'string' && payload.cwd.trim() !== ''
      ? resolve(payload.cwd)
      : process.cwd();
  const rawStoreOverride = process.env.ADLC_TICKET_STORE ?? process.env.ADLC_TICKETS ?? null;
  const storeOverride = sanitizeDiscoveryStoreOverride(rawStoreOverride, toolCwd, process.cwd());
  const outerRoot = findInnermostCheckoutRoot(toolCwd, { storeOverride, preserveSpelling: true }) ?? toolCwd;
  const dynamicPaths = collectDynamicTargets(payload, toolCwd, payload);
  const candidateRoots = resolveCandidateBuildGateRoots(outerRoot, dynamicPaths, storeOverride);
  const adlcRoots = candidateRoots.filter(
    (r) => existsSync(join(r, '.adlc')) && ticketStoreExists(r, envForCheckout(r, outerRoot))
  );
  if (adlcRoots.length === 0) process.exit(0); // not an ADLC repo / no tickets → allow

  // Recovery Exception & Inspection Bash Exception (context-rot-threshold-
  // calibration spec §1.3), applied to THIS gate too — evaluated before any
  // of build-gate's own high-risk/degraded-context deny logic below.
  const name = toolNameOf(payload);
  if (isRecoveryEligibleToolName(name)) {
    const candidates = collectCommandText(payload).filter((c) => typeof c === 'string' && c.length > 0);
    if (candidates.length === 1) {
      const [candidateCommand] = candidates;
      if (isBareInspectionPwd(candidateCommand)) process.exit(0); // unconditional allow, no audit record
      for (const projectRoot of adlcRoots) {
        const entry = resolveContextHandoffEntry({ projectRoot });
        const trustedRecoveryCliPath = entry ? join(dirname(dirname(entry)), 'bin', 'handoff.mjs') : null;
        if (!trustedRecoveryCliPath) continue;
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
            cwd: projectRoot,
          });
          process.exit(0); // allow — never gated on the audit record above succeeding
        }
      }
    }
  }

  const bypassRequested = process.env.ADLC_BUILD_GATE_BYPASS === '1';
  for (const root of adlcRoots) {
    const checkoutEnv = envForCheckout(root, outerRoot);
    const active = resolveActiveTicketId(root, checkoutEnv);
    if (!active.id) continue; // no active ticket declared in this checkout → opt-in gate

    let ticket;
    try {
      ticket = loadTicketStoreReadOnly({ root, env: checkoutEnv }).tickets.find((t) => t.id === active.id);
    } catch (e) {
      fail(`cannot read the ticket store (${e.message}) — active ticket ${active.id}'s risk cannot be verified, failing closed`);
    }
    if (!ticket) fail(`active ticket ${active.id} not found in the ticket store — failing closed`);

    const result = decide({ ticket, transcriptPath: payload.transcript_path, bypassRequested });
    if (result.decision === 'allow') continue;
    if (result.decision === 'pending-bypass') {
      if (recordBuildGateBypass(active.id, result.signals, result.depth, result.sessionBytes, { cwd: root })) continue;
      fail('ADLC_BUILD_GATE_BYPASS is set but the override could not be recorded to the gate-manifest (is @adlc/cli installed and .adlc writable?). An unaudited bypass is refused — the build is blocked.');
    }
    fail(result.reason);
  }
  process.exit(0);
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
