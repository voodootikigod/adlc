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

import { existsSync, readFileSync, openSync, fstatSync, readSync, closeSync, writeSync, statSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTicketStoreReadOnly, ticketStoreExists } from './generated-ticket-reader.mjs';
import { resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';

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

export function resolveTrustedBinary(name, pathEnv) {
  for (const { candidate, rejection } of binaryCandidates(name, pathEnv)) {
    if (rejection === null) return candidate;
  }
  return null;
}

/**
 * Why a stat'ed candidate may not run, or null when it may. Accepted: a file this
 * user owns, or a `sudo npm i -g` install, where the file, the PATH entry naming
 * it (`link`, from lstat) and the directory holding that entry are all owned by
 * root, and neither the file nor the directory is writable by group or others.
 * Only root can create root-owned entries, so a symlink someone else planted,
 * pointing at a root-owned program such as /bin/sh, is still refused: the link
 * itself is not root's. A symlink's own mode bits are always 0777 and never
 * consulted; the directory decides who can replace it. `ancestors` are the
 * directories above the real file and above the PATH directory, up to `/`:
 * another account able to write any of them could swap what runs.
 */
export function ownershipRejection({ file, link, dir, ancestors = [] }, selfUid) {
  if (file.uid === selfUid) return null;
  if (file.uid !== 0) return `it is owned by uid ${file.uid}, not by you or by root`;
  const locked = (st) => st.uid === 0 && (st.mode & 0o022) === 0;
  if (!locked(file)) return 'it is root-owned but writable by group or others';
  const isSymlink = (link.mode & 0o170000) === 0o120000;
  if (link.uid !== 0 || (!isSymlink && !locked(link))) return 'it is reached through a link that root does not own';
  if (!locked(dir)) return 'its directory is not root-owned or is writable by group or others';
  if (!ancestors.every(locked)) return 'a directory above it is not root-owned or is writable by group or others';
  return null;
}

/** The directories above `file`, nearest first, up to and including the filesystem root. */
export function ancestorDirs(file) {
  const out = [];
  for (let d = dirname(file); ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}

/** The directories whose writers could swap what `candidate` runs: those above its real file and above the real PATH entry. */
export function candidateAncestors(candidate, dir, name) {
  return [...ancestorDirs(realpathSync(candidate)), ...ancestorDirs(join(realpathSync(dir), name))];
}

/** Every `name` file on PATH in order, each with its rejection reason (null when trusted). Never runs one. */
function binaryCandidates(name, pathEnv) {
  if (typeof pathEnv !== 'string') return []; // an empty PATH splits to one empty entry, skipped below
  const sep = process.platform === 'win32' ? ';' : ':';
  const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const out = [];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    let file;
    try {
      file = statSync(candidate);
    } catch {
      continue; // no file here: try next PATH entry
    }
    if (!file.isFile()) continue;
    let stats = null;
    try {
      stats = candidateStats(candidate, dir, name, file, selfUid);
    } catch {
      /* refused below as uninspectable */
    }
    out.push({ candidate, rejection: candidateRejection(dir, stats, selfUid) });
  }
  return out;
}

/**
 * What ownershipRejection judges for an existing `candidate`: the followed file,
 * the PATH entry itself (lstat), its directory, and, for a root-owned file this
 * user does not own, every directory above the real file and the real PATH entry.
 * Throws when any of them cannot be stat'ed.
 */
export function candidateStats(candidate, dir, name, file, selfUid) {
  const stats = { file, link: lstatSync(candidate), dir: statSync(dir) };
  if (file.uid === 0 && file.uid !== selfUid) {
    stats.ancestors = candidateAncestors(candidate, dir, name).map((d) => statSync(d));
  }
  return stats;
}

/**
 * Why the candidate found in PATH entry `dir` may not run (null when it may).
 * Where it was found is judged first, so a repository-controlled location is
 * named even when its stats are missing; `stats` is null when they could not
 * be gathered.
 */
export function candidateRejection(dir, stats, selfUid) {
  if (!isAbsolute(dir)) return 'it is reached through a relative PATH entry, which resolves inside the repository';
  if (dir.includes('node_modules')) return 'it is inside node_modules, where a repository could have placed it';
  if (stats === null) return 'its link or a directory above it could not be inspected';
  return selfUid === null ? null : ownershipRejection(stats, selfUid);
}

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

async function main() {
  if (!existsSync('.adlc')) process.exit(0); // not an ADLC repo → allow
  if (!ticketStoreExists(process.cwd(), process.env)) process.exit(0); // no tickets → nothing to gate → allow

  const payload = await stdinJson();
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
  // Copilot 1.0.73 preToolUse stdin exposes no session transcript field, so this
  // branch is the ONLY one taken on Copilot today (the gate is inert — see the
  // file header). The lookup is kept forward-compatible: if a future Copilot
  // build exposes a transcript/log field, decide() engages automatically; a
  // transcript that IS provided but unreadable still fails closed there.
  const transcriptPath = payload.transcriptPath ?? payload.transcript_path ?? payload.logPath;
  if (transcriptPath === undefined) {
    console.error('adlc-build-gate: no session transcript exposed by Copilot (1.0.73) — context-fitness cannot be measured, so this gate is inert; allowing.');
    process.exit(0);
  }
  const result = decide({ ticket, transcriptPath, bypassRequested });

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
