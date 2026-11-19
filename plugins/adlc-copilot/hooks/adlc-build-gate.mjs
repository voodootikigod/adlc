#!/usr/bin/env node
// adlc-build-gate.mjs — GitHub Copilot CLI adapter of the context-fitness build
// gate (T49), ported from plugins/adlc-codex/hooks/adlc-build-gate.mjs. Only the
// I/O contract differs, per the verified Copilot binary contract (1.0.73 — see
// docs/integrations/copilot-probe-appendix.md): DENY = a non-empty
// `{"reason":…}` object on STDOUT + exit 0 (not exit 2, not permissionDecision);
// this adapter never throws to the OS (Copilot fails OPEN on a crashed hook), so
// internal errors deny.
//
// !!! CURRENTLY INERT ON COPILOT !!! The context-fitness signal needs a session
// transcript, but Copilot 1.0.73's preToolUse stdin exposes NONE — it carries
// only `{ sessionId, timestamp, cwd, toolName, toolArgs }` (verified live in the
// #240 deny-proof; see docs/integrations/copilot-probe-appendix.md §2.1). So
// `transcriptPath` is always undefined, main() always takes the advisory-allow
// early-exit, and decide() (the only branch that can deny) is never reached: this
// gate NEVER denies on Copilot. It is kept wired — harmless (always allows) and
// zero-cost — so it activates automatically if Copilot ever exposes a session
// transcript/log field. Until then, Copilot context-rot protection relies on
// operator discipline + the P4 flail advisory, NOT this gate. This inertness is
// disclosed in docs/integrations/copilot.md (Gaps / Caveats) and the matrix.
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

import { existsSync, readFileSync, openSync, fstatSync, readSync, closeSync, writeSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTicketStoreReadOnly, ticketStoreExists } from './generated-ticket-reader.mjs';
import { resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';
import {
  canonicalizePath,
  extractAllToolWorkdirs,
  findInnermostCheckoutRoot,
  inspectGitCheckout,
  isPathInside,
  preferInnermostCheckout,
} from './generated-workspace-root.mjs';
import { collectPatchPaths } from './generated-shell.mjs';
import {
  resolveTrustedBinary,
  ownershipRejection,
  ancestorDirs,
  candidateAncestors,
  binaryCandidates,
  candidateStats,
  candidateRejection,
  untrustedBinaryReason,
} from './generated-trusted-binary.mjs';

export {
  resolveTrustedBinary,
  ownershipRejection,
  ancestorDirs,
  candidateAncestors,
  binaryCandidates,
  candidateStats,
  candidateRejection,
  untrustedBinaryReason,
};

function emitDeny(reason) {
  // Verified Copilot deny shape (1.0.73): non-empty object on stdout, exit 0.
  // exit 2 is NOT honored by the CLI; see docs/integrations/copilot-probe-appendix.md.
  // Synchronous fd-1 write so process.exit() cannot truncate the deny (an
  // unflushed async write would be read as empty stdout → allow → fail OPEN).
  try { writeSync(1, `${JSON.stringify({ reason })}\n`); } catch { /* fd closed */ }
  process.exit(0);
}

function fail(message) {
  emitDeny(`adlc-build-gate: ${message}`);
}

// Application-level fail-safe: Copilot fails OPEN on a crashed hook, so convert
// any unexpected throw/rejection into a deny rather than dying non-zero.
process.on('uncaughtException', (error) => {
  emitDeny(`adlc-build-gate: internal error, denying to fail safe: ${error?.message ?? error}`);
});
process.on('unhandledRejection', (error) => {
  emitDeny(`adlc-build-gate: internal error, denying to fail safe: ${error?.message ?? error}`);
});

async function stdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

/**
 * The repository a hook decision is about.
 *
 * Copilot's preToolUse stdin carries `cwd` — the directory the tool call targets.
 * The hook PROCESS may start somewhere else (an older CLI, a `/cd`, a worktree
 * switch), and a repository read anchored on process.cwd() then finds no
 * `.adlc/`, no pointer and no store, and the gate allows: a silent fail-open of
 * an enforcing hook (#811). So the payload names the repository, and the process
 * cwd is only the fallback for a payload that carries no usable `cwd`.
 *
 * Pure on purpose: `fallback` is passed in by the caller, never read here, so
 * the derivation can be tested without a process.
 */
export function payloadRoot(payload, fallback) {
  const cwd = payload?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? resolve(cwd) : fallback;
}

function realpathOrSelf(path) {
  try { return realpathSync(path); } catch { return path; }
}

// Enforcing gate: a malformed/conflicting pointer fails closed, matching
// adlc-rails-guard.mjs's resolveActiveTicketId().
function resolveActiveTicketId(root, env = process.env) {
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
// KEEP IN SYNC with plugins/adlc-codex/hooks/adlc-build-gate.mjs's
// recordBuildGateBypass and adlc-handoff-gate.mjs's resolveTrustedBinary /
// RECOVERY_AUDIT_ENV_ALLOWLIST. Inlined because this hook runs from the
// plugin's installed location, which has no node_modules to import from.
//
// A repository can plant `node_modules/.bin/adlc` ahead of a real install, and
// a resolved binary's provenance cannot be fully verified, so the binary is
// resolved with node_modules entries skipped and its child sees only an
// allowlisted environment: never ADLC_MANIFEST_KEY, ADLC_ADMIN_KEY, or any
// other credential the operator's shell exports.
// ---------------------------------------------------------------------------

/** The only variables the bypass recorder's child inherits. */
export const BYPASS_RECORD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'NODE_PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'USER',
  'LOGNAME',
]);

// A recorder that never exits is killed after this long. The killed child has
// no exit status, so the bypass counts as unrecorded and the gate denies —
// promptly, instead of holding the tool call until the host gives up.
const BYPASS_RECORD_TIMEOUT_MS = 5000;

function allowlistedEnv(env) {
  return Object.fromEntries(
    BYPASS_RECORD_ENV_ALLOWLIST.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  );
}

const MANIFEST_SCAN_MAX_FILES = 500;
const MANIFEST_SCAN_MAX_BYTES_PER_FILE = 1024 * 1024;
const MANIFEST_SCAN_DEADLINE_MS = 1000;

/**
 * Whether any entry in `.adlc/manifest.jsonl` or `.adlc/manifest.d/*.jsonl`
 * under `repoRoot` carries a signature. Returns true whenever that cannot be
 * ruled out: a non-regular file, an oversized file, a malformed line, too many
 * segments, an I/O error or an exhausted time budget. Never throws.
 * KEEP IN SYNC with repoManifestChainIsSigned in plugins/adlc-codex/hooks/adlc-handoff-gate.mjs.
 */
export function manifestChainIsSigned(repoRoot) {
  const startMs = Date.now();
  try {
    const files = [];
    const root = join(repoRoot, '.adlc', 'manifest.jsonl');
    if (existsSync(root)) files.push(root);
    const segDir = join(repoRoot, '.adlc', 'manifest.d');
    if (existsSync(segDir)) {
      if (!lstatSync(segDir).isDirectory()) return true;
      const names = readdirSync(segDir);
      if (names.length > MANIFEST_SCAN_MAX_FILES) return true;
      for (const name of names) if (name.endsWith('.jsonl')) files.push(join(segDir, name));
    }
    for (const file of files) {
      if (Date.now() - startMs > MANIFEST_SCAN_DEADLINE_MS) return true;
      const st = lstatSync(file);
      if (!st.isFile() || st.size > MANIFEST_SCAN_MAX_BYTES_PER_FILE) return true;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry && typeof entry.sig === 'string' && entry.sig.length > 0) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function recordBuildGateBypass(ticketId, signals, depth, sessionBytes, { cwd } = {}) {
  // The child never receives a signing key, and an unsigned entry after a
  // signed one corrupts the chain, so a signed chain leaves the bypass
  // unrecorded and the gate denies.
  if (manifestChainIsSigned(cwd ?? process.cwd())) return false;
  const adlcBinPath = resolveTrustedBinary('adlc', process.env.PATH);
  if (!adlcBinPath) return false;
  // A global install links an extensionless `adlc` to a `.mjs` target, and Node
  // decides an extensionless entry point's module type differently across
  // versions; running the real, extensioned path makes it unambiguous. Invoking
  // it through this process's own interpreter also avoids the shebang's second,
  // unfiltered PATH lookup for `node`.
  let binPath = adlcBinPath;
  try { binPath = realpathSync(adlcBinPath); } catch { /* use the candidate as-is */ }
  const args = [
    binPath,
    'gate-manifest', 'record', 'build-gate-bypass',
    '--ticket', ticketId,
    '--data', JSON.stringify({ signals, depth, sessionBytes }),
  ];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: allowlistedEnv(process.env),
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

function collectDynamicTargets(value, baseDir, rootPayload = value, out = [], seen = new Set()) {
  if (!value) return out;
  if (typeof value === 'string') {
    const patches = new Set();
    collectPatchPaths(value, patches);
    for (const p of patches) out.push(resolve(baseDir, p));
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
      const patches = new Set();
      collectPatchPaths(child, patches);
      for (const p of patches) out.push(resolve(baseDir, p));
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

function envForCheckout(checkoutRoot, outerRoot, processCwd, baseEnv = process.env) {
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
          isPathInside(processCwd, checkoutRoot) &&
          isPathInside(resolve(processCwd, trimmed), checkoutRoot) &&
          existsSync(resolve(processCwd, trimmed))
        ) {
          next[key] = resolve(processCwd, trimmed);
        }
        continue;
      }
      if (
        isPathInside(processCwd, checkoutRoot) &&
        isPathInside(resolve(processCwd, trimmed), checkoutRoot) &&
        existsSync(resolve(processCwd, trimmed))
      ) {
        next[key] = resolve(processCwd, trimmed);
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
      isPathInside(processCwd, checkoutRoot) &&
      isPathInside(resolve(processCwd, trimmed), checkoutRoot) &&
      existsSync(resolve(processCwd, trimmed))
        ? resolve(processCwd, trimmed)
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
  // The payload is read FIRST: it names the repository every check below is
  // about (see payloadRoot). The existence checks that used to gate the stdin
  // read were anchored on process.cwd(), which is not that repository.
  const rawPayload = await stdinJson();
  const payload =
    rawPayload && typeof rawPayload === 'object' ? { ...rawPayload } : {};
  if (typeof payload.toolArgs === 'string' && payload.tool_input === undefined) {
    try {
      payload.tool_input = JSON.parse(payload.toolArgs);
    } catch {
      payload.tool_input = payload.toolArgs;
    }
  }
  const processCwd = process.cwd();
  const toolCwd = payloadRoot(payload, processCwd);
  const rawStoreOverride = process.env.ADLC_TICKET_STORE ?? process.env.ADLC_TICKETS ?? null;
  const storeOverride = sanitizeDiscoveryStoreOverride(rawStoreOverride, toolCwd, processCwd);
  const outerRoot = findInnermostCheckoutRoot(toolCwd, { storeOverride, preserveSpelling: true }) ?? toolCwd;
  const dynamicPaths = collectDynamicTargets(payload, toolCwd, payload);
  const candidateRoots = resolveCandidateBuildGateRoots(outerRoot, dynamicPaths, storeOverride);
  const primaryDisplayRoot = candidateRoots[0] ?? outerRoot;
  if (realpathOrSelf(primaryDisplayRoot) !== realpathOrSelf(processCwd)) {
    console.error(`adlc-build-gate: resolving the repository from the payload cwd ${primaryDisplayRoot} (process cwd ${processCwd})`);
  }

  const adlcRoots = candidateRoots.filter(
    (r) => existsSync(join(r, '.adlc')) && ticketStoreExists(r, envForCheckout(r, outerRoot, processCwd))
  );
  if (adlcRoots.length === 0) process.exit(0); // not an ADLC repo / no tickets → allow

  const bypassRequested = process.env.ADLC_BUILD_GATE_BYPASS === '1';
  const transcriptPath = payload.transcriptPath ?? payload.transcript_path ?? payload.logPath;

  for (const root of adlcRoots) {
    const checkoutEnv = envForCheckout(root, outerRoot, processCwd);
    const active = resolveActiveTicketId(root, checkoutEnv);
    if (!active.id) continue; // no active ticket declared → opt-in gate

    let ticket;
    try {
      ticket = loadTicketStoreReadOnly({ root, env: checkoutEnv }).tickets.find((t) => t.id === active.id);
    } catch (e) {
      fail(`cannot read the ticket store (${e.message}) — active ticket ${active.id}'s risk cannot be verified, failing closed`);
    }
    if (!ticket) fail(`active ticket ${active.id} not found in the ticket store — failing closed`);

    if (transcriptPath === undefined) continue;
    const result = decide({ ticket, transcriptPath, bypassRequested });
    if (result.decision === 'allow') continue;
    if (result.decision === 'pending-bypass') {
      if (recordBuildGateBypass(active.id, result.signals, result.depth, result.sessionBytes, { cwd: root })) continue;
      fail('ADLC_BUILD_GATE_BYPASS is set but the override could not be recorded to the gate-manifest (is @adlc/cli installed and .adlc writable?). An unaudited bypass is refused — the build is blocked.');
    }
    fail(result.reason);
  }

  if (transcriptPath === undefined) {
    console.error('adlc-build-gate: no session transcript exposed by Copilot (1.0.73) — context-fitness cannot be measured, so this gate is inert; allowing.');
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
