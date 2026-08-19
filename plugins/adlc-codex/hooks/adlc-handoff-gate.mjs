#!/usr/bin/env node
// adlc-handoff-gate.mjs — Codex port of the context-rot handoff deny
// (slice 5 of docs/specs/context-rot-handoff.md; Claude Code shipped first as
// slice 4). Codex is an ENFORCING tier: under the deny-set the agent loses
// structured edits AND the shell wholesale.
//
// Unlike adlc-rails-guard.mjs / adlc-build-gate.mjs, this hook does NOT inline
// a copy of the logic it enforces. D1-D3, the band thresholds, the protected
// path list and the mutating-shell detector all come from
// `@adlc/context-handoff`, resolved at runtime by handoff-resolve.mjs (a
// verbatim copy of the Claude Code resolver, pinned by
// hooks/test/handoff-resolve-drift.test.mjs). A hook cannot bare-import an npm
// package from its installed location, but it CAN walk up to the project's
// node_modules — which is what the resolver does, and why the copy exists.
//
// Session identity: the payload's `session_id` (or `sessionId`) when Codex
// supplies one, else the stem of `transcript_path` (uuid.jsonl → uuid) — the
// same source adlc-build-gate.mjs already trusts for the context signal. With
// no usable id, mutations fail closed once the handoff band fires or the deny
// store is already in play; a clean repo stays editable.

import { existsSync, readFileSync, realpathSync, statSync, opendirSync, lstatSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { isAbsolute, relative, resolve, join, basename, extname, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { loadContextHandoff, resolveContextHandoffEntry } from './handoff-resolve.mjs';
import { countToolCalls } from './adlc-build-gate.mjs';
import { resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';

function fail(message) {
  console.error(`adlc-handoff-gate: ${message}`);
  process.exit(2);
}

// Round-5 review: the top-level crash handler (below, wrapping `main()`)
// cannot see `main()`'s local `sessionId`, so an unexpected error denied
// with no recovery command at all. Set as early as possible inside main()
// (best-effort; never throws), so the crash handler can still append a
// real, session-bound recoveryDiagnostic when the crash happens after
// session identity was resolvable.
let lastKnownSessionId = null;

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// --- payload readers (Codex tool shapes) ------------------------------------

export function toolNameOf(payload) {
  return (
    payload?.tool_name ??
    payload?.toolName ??
    payload?.tool ??
    payload?.name ??
    payload?.recipient_name ??
    ''
  );
}

export function isShellToolName(name) {
  return /(^|\.)(bash|shell|exec|exec_command|run_command|write_stdin)$/i.test(String(name));
}

/**
 * Recovery Exception & Inspection Bash Exception tool-identity gate (spec
 * §1.3, Phase 0, AC0) — a SEPARATE, narrower, exact allowlist from
 * `isShellToolName` above, deliberately NOT reusing it. `isShellToolName` is
 * calibrated for the denial side, where over-inclusion is the safe direction
 * (catch anything that might be a shell so it gets scrutinized). Reusing it
 * for an UNCONDITIONAL-ALLOW exception inverts that safety property, and it
 * has two concrete problems for this purpose: (1) `write_stdin` delivers
 * input to an EXISTING process (a REPL, editor, whatever the session left
 * running) — the same literal text means something entirely different
 * depending on that process's state, which this exception has no way to
 * inspect; (2) its `(^|\.)` anchor permits any prefix before the dot, so a
 * tool registered as `evil.exec_command` would pass. `run_command` is
 * excluded conservatively — its standalone-execution semantics relative to
 * `exec_command` are not independently verified here.
 */
const RECOVERY_TOOL_NAMES = new Set(['exec_command', 'functions.exec_command', 'exec', 'Bash', 'bash', 'Shell', 'shell']);

/** @param {unknown} name @returns {boolean} */
export function isRecoveryEligibleToolName(name) {
  return RECOVERY_TOOL_NAMES.has(String(name));
}

// --- Recovery Exception & Inspection Bash Exception (trusted local copy) ---
// Verbatim twin of packages/context-handoff/lib/recovery-exception.mjs's
// `isBareInspectionPwd` / `matchRecoveryCommand`. Lives here — not sourced
// via the dynamically-loaded package — for the same reason the Claude Code hook
// keeps its own copy (see plugins/adlc-claude-code/hooks/handoff-gate.mjs's
// "KEEP IN SYNC (2)" note): these two gate the operator's own escape hatch
// out of a Hard-Degraded session, including a session where the package
// itself failed to load or lacks the required exports (stale/incompatible
// install, or a malicious project-resolved package). If that check depended
// on the package's `await import()` succeeding, a broken/hostile package
// would deny `pwd` and the recovery CLI before ever reaching it — the exact
// total-lockout bug this hotfix exists to close, just triggered by package
// health instead of scan-threshold miscalibration. Pinned by
// packages/context-handoff/adapter-test/codex-helper-drift.test.mjs.

const RECOVERY_PATH_UNQUOTED_RE = /^[A-Za-z0-9_./=-]+$/;
const RECOVERY_VALUE_RE = /^[A-Za-z0-9_./=:-]+$/;
const RECOVERY_SUBCOMMANDS = ['bypass', 'unlock', 'repair', 'write', 'resume'];
const RECOVERY_SUBCOMMAND_FLAGS = {
  bypass: { '--session': 'value', '--ticket': 'value', '--write': 'boolean', '--json': 'boolean' },
  unlock: {
    '--session': 'value',
    '--pid': 'value',
    '--started-at': 'value',
    '--host': 'value',
    '--nonce': 'value',
    '--write': 'boolean',
    '--json': 'boolean',
  },
  repair: {
    '--session': 'value',
    '--ticket': 'value',
    '--content-hash': 'value',
    '--host': 'value',
    '--write': 'boolean',
    '--json': 'boolean',
  },
  write: {
    '--session': 'value',
    '--ticket': 'value',
    '--host': 'value',
    '--content-hash': 'value',
    '--write': 'boolean',
    '--json': 'boolean',
  },
  resume: { '--session': 'value', '--deny-session': 'value', '--write': 'boolean', '--json': 'boolean' },
};

function recoveryTokenize(raw) {
  if (typeof raw !== 'string') return null;
  if (/[\r\n]/.test(raw)) return null;
  const tokens = [];
  let cur = '';
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i];
    if (ch === ' ') {
      tokens.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (ch === "'") {
      cur += ch;
      i += 1;
      let closed = false;
      while (i < n) {
        cur += raw[i];
        if (raw[i] === "'") {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) return null;
      // A real POSIX shell concatenates adjacent quoted spans after removing
      // every quote ('/a''b' → /ab). The only way this parser stays
      // equivalent to what the shell actually executes is if the closing
      // quote is immediately followed by a separator or end-of-string —
      // never by more content, quoted or not. Reject the WHOLE command
      // outright rather than guess which interpretation is correct.
      if (i < n && raw[i] !== ' ') return null;
      continue;
    }
    cur += ch;
    i += 1;
  }
  tokens.push(cur);
  return tokens;
}

function recoveryParsePathToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  if (token.length >= 2 && token[0] === "'" && token[token.length - 1] === "'") {
    const inner = token.slice(1, -1);
    if (inner.includes('\0') || /[\r\n]/.test(inner)) return null;
    return inner;
  }
  if (RECOVERY_PATH_UNQUOTED_RE.test(token)) return token;
  return null;
}

function recoveryIdentityMatches(candidatePath, expectedPath) {
  if (typeof candidatePath !== 'string' || !candidatePath.startsWith('/')) return false;
  try {
    return realpathSync(candidatePath) === realpathSync(expectedPath);
  } catch {
    return false;
  }
}

/**
 * @param {string} commandText
 * @param {{ interpreterPath: string, scriptPath: string, sessionId: string|null }} opts
 * @returns {{ matched: true, subcommand: string } | { matched: false }}
 */
export function matchRecoveryCommand(commandText, { interpreterPath, scriptPath, sessionId } = {}) {
  const NO_MATCH = { matched: false };
  const tokens = recoveryTokenize(commandText);
  if (!tokens || tokens.length < 3) return NO_MATCH;

  const [interpreterTok, scriptTok, subcommandTok, ...rest] = tokens;

  const interpreterCandidate = recoveryParsePathToken(interpreterTok);
  if (interpreterCandidate === null || !interpreterCandidate.startsWith('/')) return NO_MATCH;
  if (!recoveryIdentityMatches(interpreterCandidate, interpreterPath)) return NO_MATCH;

  const scriptCandidate = recoveryParsePathToken(scriptTok);
  if (scriptCandidate === null || !scriptCandidate.startsWith('/')) return NO_MATCH;
  if (!recoveryIdentityMatches(scriptCandidate, scriptPath)) return NO_MATCH;

  if (!RECOVERY_VALUE_RE.test(subcommandTok) || !RECOVERY_SUBCOMMANDS.includes(subcommandTok)) return NO_MATCH;
  const subcommand = subcommandTok;
  const flagSpec = RECOVERY_SUBCOMMAND_FLAGS[subcommand];

  const seenFlags = new Set();
  let i = 0;
  while (i < rest.length) {
    const flagTok = rest[i];
    if (!flagTok.startsWith('--') || !RECOVERY_VALUE_RE.test(flagTok)) return NO_MATCH;
    const kind = flagSpec[flagTok];
    if (kind === undefined) return NO_MATCH;
    if (seenFlags.has(flagTok)) return NO_MATCH;
    seenFlags.add(flagTok);

    if (kind === 'boolean') {
      i += 1;
      continue;
    }

    const valueTok = rest[i + 1];
    if (valueTok === undefined || !RECOVERY_VALUE_RE.test(valueTok) || valueTok.startsWith('--')) return NO_MATCH;

    if (flagTok === '--session') {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return NO_MATCH;
      if (valueTok !== sessionId) return NO_MATCH;
    }

    i += 2;
  }

  // Round-5 review: the per-flag check above only enforces same-session
  // binding WHEN --session is present — a command that omits --session
  // entirely (e.g. a bare `bypass`) matched unconditionally regardless of
  // sessionId, evading the binding it exists to enforce. Every subcommand's
  // flag spec allows --session, so requiring it here (unconditionally, not
  // just for the subcommands that happen to declare it) closes that gap
  // without special-casing any one subcommand.
  if (!seenFlags.has('--session')) return NO_MATCH;

  return { matched: true, subcommand };
}

/**
 * @param {unknown} commandText
 * @returns {boolean}
 */
export function isBareInspectionPwd(commandText) {
  if (typeof commandText !== 'string') return false;
  return commandText === 'pwd';
}

/**
 * Trusted local twin of `@adlc/context-handoff`'s `quotePathForDisplay` — see
 * that function's comment (recovery-exception.mjs) for why a literal
 * apostrophe or CR/LF cannot be safely represented.
 * @param {string} p
 * @returns {string|null}
 */
function quotePathForDisplay(p) {
  if (typeof p !== 'string' || p.includes("'") || /[\r\n]/.test(p)) return null;
  return RECOVERY_PATH_UNQUOTED_RE.test(p) ? p : `'${p}'`;
}

/**
 * Trusted local twin of `@adlc/context-handoff`'s `formatUnsafeInstallPathMessage`.
 * @param {{ interpreterPath: string, scriptPath: string, sessionId: string }} opts
 * @returns {string}
 */
export function formatUnsafeInstallPathMessage({ interpreterPath, scriptPath, sessionId }) {
  return (
    'The recovery command cannot be printed as a safe, copy-pasteable shell command: the resolved install ' +
    'path contains a character (a literal apostrophe or a newline) that cannot be represented in one. Run ' +
    `the operator recovery CLI manually — interpreter at ${interpreterPath}, script at ${scriptPath}, ` +
    `subcommand "bypass --session ${sessionId} --write". \`pwd\` remains usable in the interim.`
  );
}

/**
 * Trusted local twin of `@adlc/context-handoff`'s `formatNoSessionIdMessage`.
 * @returns {string}
 */
export function formatNoSessionIdMessage() {
  return (
    'No session id could be resolved for this session, so no session-specific recovery command can be ' +
    'printed. End this session and start a new one — the host will mint a fresh session id, unaffected by ' +
    'this resolution failure. In the interim, `pwd` remains usable.'
  );
}

/**
 * Trusted local twin of `@adlc/context-handoff`'s `formatRecoveryCommand` —
 * see that function's comment (recovery-exception.mjs) for the full
 * injection-safety rationale (session-id VALUE_GRAMMAR validation, per-path
 * quoting, degrade-don't-break on an unsafe install path).
 * @param {{ interpreterPath: string, scriptPath: string, sessionId: string }} opts
 * @returns {string}
 */
export function formatRecoveryCommand({ interpreterPath, scriptPath, sessionId }) {
  if (typeof sessionId !== 'string' || !RECOVERY_VALUE_RE.test(sessionId)) {
    return formatNoSessionIdMessage();
  }
  const interpreterDisplay = quotePathForDisplay(interpreterPath);
  const scriptDisplay = quotePathForDisplay(scriptPath);
  if (interpreterDisplay === null || scriptDisplay === null) {
    return formatUnsafeInstallPathMessage({ interpreterPath, scriptPath, sessionId });
  }
  return `${interpreterDisplay} ${scriptDisplay} bypass --session ${sessionId} --write`;
}

/**
 * Trusted local twin of `@adlc/context-handoff`'s `isSafeSessionId`
 * (deny-marker.mjs) — needed so session identity can be resolved before the
 * package is loaded, which the Recovery/Inspection Exception's same-session
 * binding requires. Same rules: non-empty, no leading/trailing whitespace,
 * no path separators or `..`, and `basename(id) === id`.
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function isSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  if (sessionId.trim().length === 0 || sessionId.trim() !== sessionId) return false;
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) return false;
  if (basename(sessionId) !== sessionId) return false;
  return true;
}

/**
 * Trusted local twin of `@adlc/context-handoff`'s `resolveHandoffSessionId`
 * (adapter.mjs) — same reason as `isSafeSessionId` above.
 * @param {{ candidates?: unknown[], transcriptPath?: unknown }} opts
 * @returns {string|null}
 */
export function resolveHandoffSessionIdLocal({ candidates = [], transcriptPath } = {}) {
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

// Twin of `@adlc/context-handoff`'s BYPASS_GRANT_SCHEMA / BYPASS_GRANT_TTL_MS
// (lib/bypass-grant.mjs, lib/thresholds.mjs) — see readVerifiedBypassGrant.
const BYPASS_GRANT_SCHEMA = 2;
const BYPASS_GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_BYPASS_GRANT_BYTES = 4096;

/**
 * Trusted local twin of `@adlc/context-handoff`'s `readBypassGrant`
 * (lib/bypass-grant.mjs), with the constants above and a sorted-key payload
 * stringify standing in for `@adlc/core`'s `canonicalJson` —
 * same trust-boundary reason as every other twin in this file, sharpened:
 * verifying a bypass grant requires ADLC_MANIFEST_KEY, and the key must NEVER
 * reach the project-resolved package (a hostile repo shipping its own
 * @adlc/context-handoff would gain the manifest trust anchor). So THIS HOOK
 * verifies the grant — trusted code, key read from the pre-scrub env snapshot
 * — and passes only the verdict (`verifiedBypassGrant`) into
 * `evaluateHandoffPreToolUse`. One deliberate divergence: on an unsafe session
 * id this returns null where the canonical asserts/throws (the hook must never
 * crash on hostile input); the hook only calls it with
 * `resolveHandoffSessionIdLocal` output, which is safe by construction.
 * Pinned by packages/context-handoff/adapter-test/codex-helper-drift.test.mjs.
 *
 * @param {string} root repo root
 * @param {string|null} sessionId
 * @param {{ key?: string|null, now?: () => number }} [opts]
 * @returns {{ session_id: string, unbound_reason: string|null, written_at: string, verified: boolean } | null}
 */
export function readVerifiedBypassGrant(root, sessionId, { key = null, now = () => Date.now() } = {}) {
  if (!isSafeSessionId(sessionId)) return null;
  const path = join(root, '.adlc', 'handoffs', `${sessionId}.bypass-grant.json`);
  // Round-17 review: a separate lstat-then-readFileSync(path) had a TOCTOU —
  // a concurrent writer could swap the checked regular file for a FIFO or
  // oversized file between the two path-based operations. Opening ONCE
  // (O_NOFOLLOW so a symlink at this exact path throws ELOOP rather than
  // being followed; O_NONBLOCK so a FIFO/device swapped in can't hang this
  // OPEN either) and doing every subsequent check/read against that SAME fd
  // closes the window entirely. See @adlc/context-handoff's readBypassGrant
  // (bypass-grant.mjs) for the canonical twin this mirrors.
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  let doc;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYPASS_GRANT_BYTES) return null;
    doc = JSON.parse(readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (doc.schema !== BYPASS_GRANT_SCHEMA) return null;
  const session_id = doc.session_id;
  const unbound_reason = doc.unbound_reason ?? null;
  const written_at = doc.written_at;
  if (typeof session_id !== 'string' || session_id !== sessionId) return null;
  if (unbound_reason !== null && typeof unbound_reason !== 'string') return null;
  if (typeof written_at !== 'string') return null;
  const writtenMs = Date.parse(written_at);
  if (!Number.isFinite(writtenMs)) return null;
  if (now() - writtenMs > BYPASS_GRANT_TTL_MS) return null;
  let verified = false;
  if (typeof key === 'string' && key.length > 0 && typeof doc.sig === 'string' && doc.sig.length > 0) {
    // Keys listed in canonical (sorted) order, so this plain stringify equals
    // `@adlc/core`'s canonicalJson for this flat, primitive-valued payload —
    // the payload shape is fixed by BYPASS_GRANT_SCHEMA, so the general
    // recursive canonicalizer would be dead generality here. The drift pin
    // (codex-helper-drift.test.mjs) catches any divergence from the canonical
    // signer, including a future payload change that breaks this equality.
    const expected = createHmac('sha256', key)
      .update(JSON.stringify({ schema: BYPASS_GRANT_SCHEMA, session_id, unbound_reason, written_at }))
      .digest('hex');
    const a = Buffer.from(doc.sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    verified = a.length === b.length && timingSafeEqual(a, b);
  }
  return { session_id, unbound_reason, written_at, verified };
}

/**
 * True when any tool named ANYWHERE in the payload is a shell tool.
 *
 * `multi_tool_use.parallel` is in this hook's PreToolUse matcher, and its
 * nested calls carry their own `recipient_name`. Reading only the outer name
 * classified such an envelope as non-shell, so a nested `exec_command` reached
 * the core with `isBash:false` — skipping both the protected-path scan and the
 * wholesale shell block.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasShellToolAnywhere(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasShellToolAnywhere(item));
  for (const [key, child] of Object.entries(value)) {
    if (
      ['tool_name', 'toolName', 'tool', 'name', 'recipient_name'].includes(key) &&
      typeof child === 'string' &&
      isShellToolName(child)
    ) {
      return true;
    }
    if (hasShellToolAnywhere(child)) return true;
  }
  return false;
}

/** Every shell command string anywhere in the payload, joined for scanning. */
export function collectCommandText(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectCommandText(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['command', 'cmd', 'input', 'script', 'chars'].includes(key) && typeof child === 'string') {
      out.push(child);
    } else {
      collectCommandText(child, out);
    }
  }
  return out;
}

/** Edit targets anywhere in the payload, including apply_patch envelopes. */
export function collectEditPaths(value, out = new Set()) {
  if (typeof value === 'string') {
    collectPatchPaths(value, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectEditPaths(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      ['path', 'filePath', 'file_path', 'target', 'targetPath', 'target_path'].includes(key) &&
      typeof child === 'string'
    ) {
      out.add(child);
    } else if (['paths', 'filePaths', 'file_paths'].includes(key) && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === 'string') out.add(item);
        else collectEditPaths(item, out);
      }
    } else if (['command', 'cmd', 'patch', 'input'].includes(key) && typeof child === 'string') {
      collectPatchPaths(child, out);
    } else {
      collectEditPaths(child, out);
    }
  }
  return out;
}

function collectPatchPaths(text, out) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    for (const prefix of ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: ']) {
      if (line.startsWith(prefix)) {
        const path = line.slice(prefix.length).trim();
        if (path) out.add(path);
      }
    }
  }
}

/** Repo-relative, forward-slashed. Paths outside the repo keep their own form. */
export function toRepoRelative(path, root = process.cwd()) {
  const normalized = String(path).replaceAll('\\', '/');
  const absolute = isAbsolute(normalized) ? normalized : resolve(root, normalized);
  const rel = relative(root, absolute).replaceAll('\\', '/');
  return rel.startsWith('..') ? normalized : rel;
}

// --- context signals --------------------------------------------------------

/**
 * Read the tail `maxBytes` of `path` in fixed-size chunks, checking a
 * wall-clock deadline BETWEEN chunks — so `deadlineMs` is a real, enforced
 * ceiling on this hook's own blocking time, not merely a validated-but-inert
 * parameter. A deadline hit mid-read stops with whatever was read so far;
 * that partial text is a genuine LOWER bound (fewer bytes seen than
 * intended), so `truncated: true` correctly reflects an incomplete scan —
 * unlike a byte-budget truncation, which also always sets `truncated: true`,
 * a deadline-interrupted read never claims to have reached start-of-file.
 * Reads forward from the start of the intended window (not backward from
 * end-of-file) — order doesn't matter for a regex tool-call COUNT, and this
 * keeps the loop a single monotonic forward scan.
 *
 * @param {string} path
 * @param {{ maxBytes: number, deadlineMs: number, now?: Function, chunkBytes?: number }} opts
 * @returns {{ size: number, text: string, truncated: boolean }|null} null when the file cannot be opened
 */
const TAIL_READ_WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'tail-read-worker.mjs');

/**
 * Round-16 review (T-01M03J291182MXD1KEKM2PRKTS): the deadline check here
 * used to run only BETWEEN synchronous readSync calls inside THIS process —
 * it could never preempt a single openSync/readSync that itself blocks (a
 * stalled network mount, a FIFO with no writer, a hung device file at
 * transcript_path), leaving MAX_SCAN_WALL_MS an unenforceable ceiling
 * against exactly the failure mode it exists to bound. The actual read now
 * runs in a SEPARATE PROCESS (tail-read-worker.mjs) via `spawnSync(...,
 * { timeout })` — the OS can forcibly kill that process if it does not
 * finish in time, which nothing in-process can offer against a blocking
 * syscall. This keeps boundedTailRead itself, and every existing caller,
 * fully synchronous — no async refactor of the hook's call chain.
 */
export function boundedTailRead(path, { maxBytes, deadlineMs }) {
  const result = spawnSync(process.execPath, [TAIL_READ_WORKER_PATH, path, String(maxBytes)], {
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
    maxBuffer: maxBytes + 4096,
  });
  // A killed-on-timeout child never gets to report whether the path was even
  // openable. Safest interpretation, matching this function's own invariant
  // ("returns the depth actually accumulated — a FINITE lower bound, never
  // +Infinity"): treat it as a short read that recovered zero bytes, NOT as
  // the "couldn't open at all" null case below (observeHandoffSignals maps
  // null to NaN depth, a different and less restrictive failure path than
  // truncated:true's incomplete-scan restriction).
  if (result.signal === 'SIGKILL' || result.error?.code === 'ETIMEDOUT') {
    return { size: 0, text: '', truncated: true };
  }
  // Trust the worker's own exit code as the authoritative signal, not just
  // its self-reported `ok` header field — the exit code is set by the SAME
  // fail()/success call sites the header comes from, so this is redundant
  // with a correct header, but it means a corrupted or lying header (a
  // build defect, not an adversary — the worker is this repo's own trusted
  // code) can never be misread as success while exit status disagrees.
  if (result.status !== 0) return null;
  if (!Buffer.isBuffer(result.stdout)) return null;
  const newlineIdx = result.stdout.indexOf(0x0a);
  if (newlineIdx === -1) return null;
  let header;
  try {
    header = JSON.parse(result.stdout.subarray(0, newlineIdx).toString('utf8'));
  } catch {
    return null;
  }
  if (!header || header.ok !== true) return null;
  const { size, postSize, readSoFar } = header;
  if (
    !Number.isFinite(size) ||
    !Number.isFinite(postSize) ||
    !Number.isFinite(readSoFar) ||
    size < 0 ||
    readSoFar < 0
  ) {
    return null;
  }
  const bytes = result.stdout.subarray(newlineIdx + 1);
  if (bytes.length !== readSoFar) return null; // truncated/garbled transport — do not trust a mismatched frame
  const length = Math.min(size, maxBytes);
  const truncatedByBytes = length < size;
  // Same three incompleteness signals as before, now sourced from the
  // worker's report instead of computed in-process — see their original
  // comments (git history) for the full rationale on each.
  const shortRead = readSoFar < length;
  const grewOrShrank = postSize !== size;
  return {
    size,
    text: bytes.toString('utf8'),
    truncated: truncatedByBytes || shortRead || grewOrShrank,
  };
}

// countToolCalls comes from adlc-build-gate.mjs — the canonical Codex
// transcript counter, itself pinned to packages/build-gate by a drift test. A
// second hand-written regex here silently disagreed with it: it missed the
// `Writing|Editing|Created` prose tool-log form the real counter recognizes, so
// a deep session in that transcript shape reported depth 0 and never reached
// the band. Two counters over one transcript is one counter too many.

/**
 * Observe depth for evaluateBands. Thresholds live in `@adlc/context-handoff`;
 * nothing here compares against one. An unreadable-but-present transcript
 * yields NaN so the band classifier treats it as invalid rather than a
 * healthy zero.
 *
 * `observed.bytes` is deliberately never populated (Phase 0 hotfix,
 * context-rot-threshold-calibration spec §1.2.1): WARN_BYTES/HANDOFF_BYTES/
 * HARD_BYTES were calibrated against nothing and were tripped on turn 0-2 by
 * system-prompt/MCP-schema/rules overhead alone. `evaluateBands` already
 * treats an absent signal as `{warn:false,...}` for that signal.
 *
 * `maxActiveContextBytes`/`maxScanWallMs` are REQUIRED — the caller passes
 * the package's MAX_ACTIVE_CONTEXT_BYTES/MAX_SCAN_WALL_MS rather than a
 * local copy. The OLD single `maxScanBytes: api.HARD_BYTES` window (retired,
 * root cause of the production +Infinity lockout: a routine fresh-session
 * baseline already exceeds 256 KiB) is gone; keeping a second literal here
 * would just be a threshold copy waiting to drift.
 *
 * A scan that cannot complete within either budget before reaching
 * start-of-file returns the depth actually accumulated — a FINITE lower
 * bound, never +Infinity — and `truncated: true`, which the caller must use
 * to restrict mutating tools until a complete scan succeeds (see
 * `evaluateHandoffPreToolUse`'s `scanTruncated` param).
 *
 * The read itself goes through `boundedTailRead`, which reads in fixed-size
 * chunks and checks `maxScanWallMs` BETWEEN chunks — so the wall-clock
 * budget is a real, enforced ceiling on this hook's own blocking time, not
 * merely a validated-but-inert parameter. (An earlier version of this
 * function did a single unchunked read and only checked elapsed time AFTER
 * it returned, which could neither interrupt a slow read nor avoid
 * mislabeling a complete-but-slow read as `truncated`; `boundedTailRead`'s
 * chunking fixes both — a deadline hit genuinely stops before covering the
 * intended window, so `truncated: true` is accurate in that case, and a fast
 * read that never hits the deadline is never mislabeled.)
 *
 * @param {object} payload hook payload
 * @param {{ maxActiveContextBytes: number, maxScanWallMs: number, read?: Function }} opts
 * @returns {{ observed: { depth?: number }, truncated: boolean }}
 */
export function observeHandoffSignals(payload, { maxActiveContextBytes, maxScanWallMs, read = boundedTailRead }) {
  const tp = payload?.transcript_path;
  // No transcript field at all is an ABSENT signal: the band join ignores it, so
  // a harness that supplies no telemetry cannot hard-lock the repo.
  if (typeof tp !== 'string' || tp === '') return { observed: {}, truncated: false };
  // A path that WAS supplied but cannot be reached is a different thing — a
  // failed read of a signal that exists. Rotation, deletion, or a permission
  // error must not read as "no pressure" for a session that may be well past
  // the band. NaN is what the classifier treats as invalid, i.e. fail closed.
  if (!existsSync(tp)) return { observed: { depth: Number.NaN }, truncated: false };
  if (
    !Number.isFinite(maxActiveContextBytes) ||
    maxActiveContextBytes <= 0 ||
    !Number.isFinite(maxScanWallMs) ||
    maxScanWallMs <= 0
  ) {
    // No usable budget means the signal cannot be bounded — do not guess.
    return { observed: { depth: Number.NaN }, truncated: false };
  }

  const result = read(tp, { maxBytes: maxActiveContextBytes, deadlineMs: maxScanWallMs });
  if (result == null) return { observed: { depth: Number.NaN }, truncated: false };
  const depth = countToolCalls(result.text);
  return { observed: { depth }, truncated: result.truncated };
}

// --- main -------------------------------------------------------------------

/** Active ticket for the deny marker's `ticket_id`; unbound is fine here. */
function activeTicketIdOrNull() {
  try {
    const resolved = resolveActiveTicketIdCanonical({ root: process.cwd(), env: process.env });
    if (!resolved.ok) return null;
    return resolved.value?.id ?? null;
  } catch {
    return null;
  }
}

const REQUIRED_API = [
  'evaluateHandoffPreToolUse',
  'resolveHandoffSessionId',
  'isProtectedHandoffPath',
  'isHandoffMutatingShell',
];

/**
 * Resolve the absolute path of `name` on PATH, using an environment captured
 * BEFORE any project-controlled code has run. `loadContextHandoff` executes
 * a project-resolved package's top-level module code, which — as this
 * file's own secret-scrubbing comments already establish — must not be
 * trusted. A bare `spawnSync('adlc', ...)` issued AFTER that import does a
 * fresh PATH lookup against whatever `process.env.PATH` is AT THAT TIME; if
 * the imported package mutated it (prepending a directory with a malicious
 * `adlc`), the spawn in `recordRecoveryUnderBand` would run that
 * attacker-controlled binary instead of the real one. Binding the
 * executable's identity to the PRE-import PATH closes that specific window
 * (a runtime PATH mutation via the untrusted import).
 *
 * A separate exposure exists independent of runtime mutation: an ordinary
 * (never-mutated) PATH can already contain a project-local
 * `node_modules/.bin/adlc` shim ahead of a real global install — a
 * repository can ship that shim itself. Every PATH entry that resolves
 * inside a `node_modules` directory is skipped for that reason (a genuine
 * global install is never itself inside `node_modules`), and every
 * remaining candidate must also be owned by the CURRENT process's uid
 * (skipped otherwise, platforms where `process.getuid` exists) — a
 * project-writable or shared directory earlier on PATH can still contain a
 * file owned by this same user, which this check cannot distinguish from a
 * genuine install, but it does rule out a candidate owned by a different
 * (or root/system) account landing on PATH ahead of the real binary. Given
 * that, this function still cannot verify a same-uid candidate's symlink
 * target or content. `recordRecoveryUnderBand` does not hand this spawn the
 * manifest signing key or the admin key regardless of what runs here, and
 * `repoManifestChainIsSigned` refuses to spawn it at all once the manifest
 * has adopted signing, so the exposure this function cannot close is
 * limited to arbitrary code execution under the hook's own privileges by an
 * attacker who can already write same-uid files onto PATH, not credential
 * exfiltration through this path. Never throws; returns null (audit logging
 * is then skipped, best-effort) rather than guess.
 */
export function resolveTrustedBinary(name, pathEnv) {
  if (typeof pathEnv !== 'string' || pathEnv.length === 0) return null;
  const sep = process.platform === 'win32' ? ';' : ':';
  const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    if (dir.includes('node_modules')) continue; // see the function comment
    const candidate = join(dir, name);
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      if (selfUid !== null && st.uid !== selfUid) continue; // see the function comment
      return candidate;
    } catch {
      /* try next PATH entry */
    }
  }
  return null;
}

/** Bounds for `repoManifestChainIsSigned` — see that function's comment for why. */
const MANIFEST_SCAN_MAX_FILES = 500;
const MANIFEST_SCAN_MAX_BYTES_PER_FILE = 1 * 1024 * 1024;
const MANIFEST_SCAN_DEADLINE_MS = 1000;

/**
 * Whether ANY manifest entry reachable from `repoRoot` (root `.adlc/manifest.jsonl`
 * or any segment under `.adlc/manifest.d/`) carries a signature. Deliberately
 * fail-CLOSED (returns true — "treat as signed") whenever this cannot
 * positively prove otherwise: an unreadable file, a malformed JSONL line, or
 * an unexpected directory-listing failure all return true. `gate-manifest
 * record` does NOT fail closed on a missing key the way an earlier version of
 * this file's own comment claimed — `key: null` is a legal, silently-unsigned
 * append (see packages/tickets/lib/key-contract.mjs's `validateKeyParam` and
 * packages/gate-manifest/lib/record.mjs's `if (signingKey)` guard), and the
 * chain-integrity check it runs first only verifies the EXISTING prefix, not
 * whether the entry it is about to add would break an already-signed chain.
 * Appending an unsigned entry directly after a signed one silently corrupts
 * the chain for every later key-aware verification/preflight/tier-check.
 * `recordRecoveryUnderBand` never has a signing key to offer (see its own
 * comment), so it must refuse to append at all once the chain has adopted
 * signing — this is the check that makes "skip the append when no safe
 * signer exists" concrete.
 *
 * BOUNDED (Round-5 review): this runs SYNCHRONOUSLY, INLINE, before the
 * "unconditional" recovery allow decision returns — an earlier version read
 * every reachable file to completion with no byte, file-count, symlink, or
 * time bound. A huge or hostile `.adlc/manifest.d/` (a giant file, hundreds
 * of segments, or a symlink to an unbounded/blocking source such as a FIFO)
 * could hang or exhaust memory HERE, reproducing the exact "even the
 * recovery command itself is denied" total-lockout class of bug this ticket
 * exists to close — just triggered by manifest size instead of a threshold.
 * Every one of these limits degrades the SAME direction as every other
 * check in this function: hitting any of them proves nothing about
 * "unsigned", so the answer is "treat as signed" (skip the audit record),
 * never a hang and never a false "safe to append".
 * - `MANIFEST_SCAN_MAX_FILES`: caps directory fan-out.
 * - `MANIFEST_SCAN_MAX_BYTES_PER_FILE` + `boundedTailRead`: caps any single
 *   file's read, chunked with a deadline check between chunks (the same
 *   reader `observeHandoffSignals` already uses for the transcript scan) —
 *   a `truncated` result is treated as inconclusive, not partially parsed.
 * - `lstatSync(...).isFile()`, checked WITHOUT following symlinks: rejects
 *   symlinks, FIFOs, device files, and directories outright, before ever
 *   attempting to open them. `boundedTailRead`'s own `openSync` can still
 *   block on a genuine blocking special file it wasn't given a chance to
 *   reject — this check is what prevents that file from ever reaching it.
 * - `MANIFEST_SCAN_DEADLINE_MS`: an OVERALL wall-clock budget checked
 *   between files (not just within one), so many small files cannot
 *   collectively exceed it either.
 */
export function repoManifestChainIsSigned(repoRoot) {
  const startMs = Date.now();
  const files = [];
  try {
    const root = join(repoRoot, '.adlc', 'manifest.jsonl');
    if (existsSync(root)) files.push(root);
    const segDir = join(repoRoot, '.adlc', 'manifest.d');
    if (existsSync(segDir)) {
      // lstat the DIRECTORY itself, not following symlinks — a symlinked
      // manifest.d pointing at an unbounded/hostile directory must be
      // rejected before ever listing it (Round-5 review).
      let segDirStat;
      try {
        segDirStat = lstatSync(segDir);
      } catch {
        return true; // can't stat -> can't prove unsigned -> treat as signed
      }
      if (!segDirStat.isDirectory()) return true;
      // opendirSync + iterative reads, not readdirSync: readdirSync
      // materializes the ENTIRE directory listing into memory in one call
      // before this function ever gets a chance to check the file-count
      // cap — a directory with a huge number of entries would be fully
      // read regardless. Iterating lets the cap stop enumeration early.
      let dir;
      try {
        dir = opendirSync(segDir);
      } catch {
        return true; // can't enumerate -> can't prove unsigned -> treat as signed
      }
      try {
        let dirent;
        // Bound on EVERY entry examined, not just ones matching `.jsonl` —
        // files.length alone would never trip on a directory dominated by
        // non-.jsonl entries. Deadline checked here too, not only in the
        // later per-file loop below: enumeration itself is unbounded work.
        let examined = 0;
        while ((dirent = dir.readSync()) !== null) {
          examined += 1;
          if (examined > MANIFEST_SCAN_MAX_FILES) return true; // too much fan-out to bound -> treat as signed
          if (Date.now() - startMs > MANIFEST_SCAN_DEADLINE_MS) return true; // overall budget exceeded
          if (dirent.name.endsWith('.jsonl')) files.push(join(segDir, dirent.name));
        }
      } finally {
        try {
          dir.closeSync();
        } catch {
          /* best-effort close */
        }
      }
    }
  } catch {
    return true; // can't enumerate -> can't prove unsigned -> treat as signed
  }
  if (files.length > MANIFEST_SCAN_MAX_FILES) return true; // too much fan-out to bound -> treat as signed
  for (const file of files) {
    if (Date.now() - startMs > MANIFEST_SCAN_DEADLINE_MS) return true; // overall budget exceeded
    let st;
    try {
      st = lstatSync(file); // NOT following symlinks — see this function's comment
    } catch {
      return true; // can't stat -> can't prove unsigned -> treat as signed
    }
    if (!st.isFile()) return true; // symlink/FIFO/device/etc. -> can't safely bound a read -> treat as signed
    const result = boundedTailRead(file, {
      maxBytes: MANIFEST_SCAN_MAX_BYTES_PER_FILE,
      deadlineMs: Math.max(1, MANIFEST_SCAN_DEADLINE_MS - (Date.now() - startMs)),
    });
    if (result == null || result.truncated) return true; // unreadable or incomplete -> can't prove unsigned -> treat as signed
    for (const line of result.text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return true; // malformed line -> can't prove unsigned -> treat as signed
      }
      if (entry && typeof entry.sig === 'string' && entry.sig.length > 0) return true;
    }
  }
  return false; // every reachable entry examined and none carried a signature
}

/**
 * Best-effort audit record for an allowed Recovery Exception invocation
 * (spec §1.3). Attempted AFTER the allow decision is already final — this
 * function's own success or failure MUST NEVER affect that decision, and
 * MUST NEVER be allowed to block it either: a bounded `timeout` ensures a
 * stuck recorder cannot consume the hook's own execution budget and prevent
 * the "unconditional" recovery exception from actually completing.
 *
 * `trustedEnv` MUST be a snapshot of `process.env` captured BEFORE any
 * project-controlled code ran (see `main`'s capture, before
 * `scrubSecrets`/`loadContextHandoff`) — never the LIVE `process.env` at
 * call time. Resolving only the `adlc` executable's own path from the
 * pre-import PATH is not sufficient by itself: `adlc` is itself a
 * `#!/usr/bin/env node` script, and Node reads `NODE_OPTIONS` (and other
 * loader-affecting variables) from whatever environment the CHILD process is
 * spawned with. If that environment were rebuilt from the LIVE
 * `process.env` after importing a hostile project-resolved package, the
 * package could set `NODE_OPTIONS=--require=/malicious/preload.js` (or
 * otherwise poison the environment) and have it inherited by this spawn —
 * defeating the secret scrub via the child's own startup, not via `adlc`'s
 * resolved path at all. Using the frozen pre-import snapshot for the ENTIRE
 * child environment (not just PATH) closes that window for every OTHER
 * variable, but `resolveTrustedBinary`'s PATH search cannot fully verify the
 * resolved executable's provenance (ownership, symlink target, or content) —
 * a project-local PATH entry outside `node_modules` is still a possible
 * candidate. Given that, this function does NOT forward `ADLC_MANIFEST_KEY`
 * or `ADLC_ADMIN_KEY` to the child AT ALL, regardless of what `trustedEnv`
 * contains: the audit record this spawns is explicitly best-effort and never
 * gates the recovery allow decision (see the function-level comment below),
 * so it is not worth risking the permanent manifest signing key to attempt
 * it. Because there is never a key to offer, `repoManifestChainIsSigned` is
 * checked FIRST and the record is skipped entirely once the chain has
 * adopted signing — see that function's comment for why a keyless append is
 * not merely unsigned but actively corrupting in that case.
 * `adlcBinPath` MUST be the pre-import-resolved absolute path from
 * `resolveTrustedBinary` — never a bare `'adlc'` string (see that function's
 * comment) — so this never runs against a null path.
 */
export function recordRecoveryUnderBand({ subcommand, sessionId, trustedEnv, adlcBinPath }) {
  if (repoManifestChainIsSigned(process.cwd())) {
    console.error(
      'adlc-handoff-gate: recovery audit record skipped — the manifest chain already contains a signed entry and this hook has no signing key to offer; appending unsigned would corrupt the chain'
    );
    return;
  }
  if (!adlcBinPath) {
    console.error('adlc-handoff-gate: recovery audit record skipped — adlc binary not found on PATH');
    return;
  }
  try {
    // Build the child's environment from RECOVERY_AUDIT_ENV_ALLOWLIST only —
    // never from trustedEnv wholesale minus a denylist — because
    // resolveTrustedBinary's PATH search cannot fully verify the resolved
    // executable's provenance (ownership, symlink target, content); see this
    // function's own doc comment and RECOVERY_AUDIT_ENV_ALLOWLIST's comment.
    const env = {};
    for (const name of RECOVERY_AUDIT_ENV_ALLOWLIST) {
      if (trustedEnv[name] !== undefined) env[name] = trustedEnv[name];
    }
    // Invoke via THIS process's own already-running interpreter
    // (process.execPath), never by executing adlcBinPath directly. `adlc` is
    // itself a `#!/usr/bin/env node` script — spawnSync(adlcBinPath, ...)
    // would let the OS's shebang handling hand off to `/usr/bin/env`, which
    // does its OWN, SEPARATE PATH lookup for `node` using this child's PATH
    // (Round-5 review). That second lookup is not filtered by
    // resolveTrustedBinary's node_modules exclusion — a repository dependency
    // that plants `node_modules/.bin/node` ahead of the real Node install on
    // PATH would have it picked up here, defeating that exclusion entirely.
    // Passing adlcBinPath as an argument to the CURRENT interpreter bypasses
    // the shebang/env indirection altogether: no second PATH lookup happens.
    const args = [
      'gate-manifest',
      'record',
      'context-handoff-recovery-under-band',
      '--data',
      JSON.stringify({ subcommand, sessionId, host: 'codex' }),
    ];
    const r = spawnSync(process.execPath, [adlcBinPath, ...args], { encoding: 'utf8', env, timeout: 5000 });
    if (r.error || (typeof r.status === 'number' && r.status !== 0) || r.signal) {
      console.error(
        `adlc-handoff-gate: recovery audit record failed (${r.error?.message ?? `status=${r.status} signal=${r.signal}`}) — recovery command was still allowed`
      );
    }
  } catch (err) {
    console.error(`adlc-handoff-gate: recovery audit record errored (${err?.message ?? 'unknown'}) — recovery command was still allowed`);
  }
}

/**
 * Credentials this hook must not expose to imported code.
 *
 * KEEP IN SYNC with `HOOK_SECRET_ENV_VARS` in
 * packages/context-handoff/lib/secret-scrub.mjs, pinned by
 * hooks/test/handoff-secret-scrub.test.mjs. Inlined rather than imported
 * because it must run BEFORE the package is loaded — loading the package is
 * precisely the step it protects.
 */
const HOOK_SECRET_ENV_VARS = ['ADLC_MANIFEST_KEY', 'ADLC_ADMIN_KEY'];

/**
 * The only environment variables forwarded to the `recordRecoveryUnderBand`
 * child. `resolveTrustedBinary`'s PATH search cannot fully verify the
 * resolved executable's provenance (see that function's comment), so this
 * spawn must assume the resolved binary could be attacker-controlled and
 * bound what it can read from the environment accordingly — a denylist of
 * just the two manifest/admin keys still forwards everything else the
 * operator's shell happens to export (cloud credentials, other tool tokens,
 * an SSH agent socket). An allowlist scoped to what `adlc gate-manifest
 * record` and the `git` probe it shells out to actually need bounds that
 * exposure instead. Because this record is explicitly best-effort and never
 * gates the recovery allow decision, an audit failure caused by a missing
 * environment variable is an acceptable, disclosed degradation — the same
 * class of residual as any other recording failure this path already
 * tolerates.
 */
const RECOVERY_AUDIT_ENV_ALLOWLIST = [
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
];

/**
 * Delete credentials from this process's environment.
 *
 * handoff-resolve.mjs resolves the gate implementation from the PROJECT's
 * node_modules, so the module imported below is project-controlled code running
 * in this process — it can read `process.env` directly. Passing
 * `manifestKey: null` into the gate does not help while the value is still in
 * the environment that module inherits.
 *
 * @returns {string[]} names actually removed
 */
export function scrubSecrets(env = process.env) {
  const removed = [];
  for (const name of HOOK_SECRET_ENV_VARS) {
    if (env[name] === undefined) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}

async function main() {
  if (!existsSync('.adlc')) process.exit(0); // not an ADLC repo → allow

  // A full snapshot of process.env captured BEFORE any project-controlled
  // code has run — see recordRecoveryUnderBand's comment for why the
  // audit-record spawn must use this frozen copy rather than ever re-reading
  // the live process.env once loadContextHandoff has executed untrusted
  // code. recordRecoveryUnderBand itself strips ADLC_MANIFEST_KEY/
  // ADLC_ADMIN_KEY from this snapshot before spawning — see its comment.
  const trustedEnvSnapshot = { ...process.env };
  // Resolved from the PRE-import PATH — see resolveTrustedBinary's comment
  // for why this must happen before loadContextHandoff runs project code.
  const trustedAdlcBinPath = resolveTrustedBinary('adlc', trustedEnvSnapshot.PATH);

  let payload = {};
  const raw = await stdinText();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      fail(`malformed hook payload JSON (${err.message}) — failing closed`);
    }
  }

  const name = toolNameOf(payload);
  const directShell = isShellToolName(name);
  // A parallel envelope is not itself a shell tool but can carry one.
  const isBash = directShell || hasShellToolAnywhere(payload);
  const bashCommand = isBash ? collectCommandText(payload).join('\n') : '';
  // Only a DIRECT shell tool skips edit-path collection: an envelope can carry a
  // nested apply_patch alongside a nested exec, and both need checking.
  const editRelPaths = directShell
    ? []
    : Array.from(collectEditPaths(payload)).map((p) => toRepoRelative(p));

  const sessionId = resolveHandoffSessionIdLocal({
    candidates: [payload.session_id, payload.sessionId],
    transcriptPath: payload.transcript_path,
  });
  lastKnownSessionId = sessionId;

  // Recovery Exception & Inspection Bash Exception (spec §1.3) — evaluated
  // BEFORE `@adlc/context-handoff` is even loaded, using ONLY trusted local
  // code (this file's own `isBareInspectionPwd`/`matchRecoveryCommand`/
  // `resolveHandoffSessionIdLocal`, plus a pure, execution-free path
  // resolution below) — never the dynamically-loaded, project-resolved
  // package. If this depended on that package loading successfully (a
  // stale/incompatible install, or a hostile project-resolved package that
  // fails to export what's expected), a broken/malicious package would deny
  // `pwd` and the recovery CLI before ever reaching this check — reproducing
  // the exact total-lockout bug this hotfix exists to close, just triggered
  // by package health instead of scan-threshold miscalibration. MUST allow
  // regardless of band state, and regardless of any Hard-Degraded/deny check
  // below. Tool-identity gate is the NARROW, separate
  // `isRecoveryEligibleToolName` allowlist above — never
  // `directShell`/`isShellToolName`/`hasShellToolAnywhere`, which are the
  // denial-side's intentionally broader classifiers. A multi_tool_use.parallel
  // envelope or any composite call is a non-match here (toolNameOf reads only
  // the top-level name — no recursive search, unlike hasShellToolAnywhere).
  // Command-text extraction requires EXACTLY ONE non-empty candidate — the
  // general `bashCommand` above joins multiple candidates for the ordinary
  // gate, which this exception must not do (zero or multiple candidates is a
  // non-match, per spec §1.3).
  if (isRecoveryEligibleToolName(name)) {
    const candidates = collectCommandText(payload).filter((c) => typeof c === 'string' && c.length > 0);
    if (candidates.length === 1) {
      const [candidateCommand] = candidates;
      if (isBareInspectionPwd(candidateCommand)) process.exit(0); // unconditional allow, no audit record

      // resolveContextHandoffEntry only resolves the package's on-disk
      // location (a filesystem/module-resolution lookup) — it does NOT
      // `import()`/execute the package, so THIS RESOLUTION STEP stays safe
      // even when the package's own code is broken or hostile: nothing here
      // runs untrusted code to compute trustedRecoveryCliPath. Resolution
      // itself, however, walks the PROJECT's own node_modules the same way
      // loadContextHandoff does elsewhere in this file — a repository that
      // ships its own @adlc/context-handoff package controls what path this
      // resolves to, and therefore what script the matcher below treats as
      // "the" recovery CLI. matchRecoveryCommand proves the invoked command
      // targets that resolved path (by realpath identity); it does not
      // independently prove that path is the genuine, unmodified package
      // this repository was built against.
      const entry = resolveContextHandoffEntry({ projectRoot: process.cwd() });
      const trustedRecoveryCliPath = entry ? join(dirname(dirname(entry)), 'bin', 'handoff.mjs') : null;
      if (trustedRecoveryCliPath) {
        const recoveryMatch = matchRecoveryCommand(candidateCommand, {
          interpreterPath: process.execPath,
          scriptPath: trustedRecoveryCliPath,
          sessionId,
        });
        if (recoveryMatch.matched) {
          recordRecoveryUnderBand({
            subcommand: recoveryMatch.subcommand,
            sessionId,
            trustedEnv: trustedEnvSnapshot,
            adlcBinPath: trustedAdlcBinPath,
          });
          process.exit(0); // allow — never gated on the audit record above succeeding
        }
      }
    }
  }

  // Host-side bypass-grant verification — MUST run here, BEFORE the secret
  // scrub below and before the project-resolved package is imported: it is
  // the only point where trusted code holds ADLC_MANIFEST_KEY (via the
  // pre-import trustedEnvSnapshot) and no project-controlled code has
  // executed. The key is used to verify the grant
  // with this file's own trusted twin (readVerifiedBypassGrant) and never
  // crosses into the project-resolved package — only the three-state verdict
  // below does.
  //   undefined = no key in this environment (or no session): the host makes
  //               no claim, the adapter behaves exactly as before.
  //   null      = key present, no valid grant: authoritative "no grant".
  //   object    = key present, grant verified: authorizes one mutation.
  let verifiedBypassGrant;
  const manifestKeyPreScrub = trustedEnvSnapshot.ADLC_MANIFEST_KEY;
  if (typeof manifestKeyPreScrub === 'string' && manifestKeyPreScrub.length > 0 && sessionId) {
    const grant = readVerifiedBypassGrant(process.cwd(), sessionId, { key: manifestKeyPreScrub });
    verifiedBypassGrant = grant && grant.verified === true ? grant : null;
  }

  // Before anything project-controlled can be imported.
  scrubSecrets();

  const api = await loadContextHandoff({ projectRoot: process.cwd() });
  if (!api) {
    fail(
      `cannot load @adlc/context-handoff — install @adlc/cli (or the workspace package) so D1-D3 can be evaluated; failing closed\n\n${recoveryDiagnostic(sessionId)}`
    );
  }
  for (const method of REQUIRED_API) {
    if (typeof api[method] !== 'function') {
      fail(`@adlc/context-handoff missing export: ${method} — failing closed\n\n${recoveryDiagnostic(sessionId)}`);
    }
  }
  if (!Number.isFinite(api.MAX_ACTIVE_CONTEXT_BYTES) || !Number.isFinite(api.MAX_SCAN_WALL_MS)) {
    fail(`@adlc/context-handoff missing scan-budget exports — failing closed\n\n${recoveryDiagnostic(sessionId)}`);
  }

  const { observed, truncated: scanTruncated } = observeHandoffSignals(payload, {
    maxActiveContextBytes: api.MAX_ACTIVE_CONTEXT_BYTES,
    maxScanWallMs: api.MAX_SCAN_WALL_MS,
  });

  const result = api.evaluateHandoffPreToolUse({
    root: process.cwd(),
    sessionId,
    observed,
    ticketId: activeTicketIdOrNull(),
    editRelPaths,
    isBash,
    bashCommand,
    host: 'codex',
    // NO manifest key here, deliberately. handoff-resolve.mjs resolves the
    // package from the PROJECT's node_modules by design (a hook cannot bare-
    // import from its install dir), so the module imported below is
    // project-controlled code. Handing it the signing key would let any
    // repository shipping a package named @adlc/context-handoff exfiltrate the
    // trust anchor for the whole manifest — a permanently forgeable one.
    //
    // The cost is that this hook cannot VERIFY a resume-auth cache, so a signed
    // resume cannot re-open a deny in-session; the gate says so by name
    // (`resume_auth_unverifiable:no_manifest_key`) and the documented path
    // stays what it already was — continue in a fresh session, or repair from a
    // terminal. In-process adapters (OpenCode, Pi) resolve the package through
    // their OWN declared dependency and do pass the key.
    // A bypass grant CAN be verified in-session: this hook verified it above
    // with its own trusted twin before the scrub, and passes only the
    // verdict — never the key.
    manifestKey: null,
    verifiedBypassGrant,
    // A hook is a fresh process per call, so there is no in-memory D1 fact to
    // carry. When a marker write SUCCEEDS the sentinel records the session and
    // mutationGateInputFromLoad reconstructs stickiness from registeredSessions.
    // When the write FAILS there is nothing durable to reconstruct from, so a
    // later call whose band has cooled will not know — a residual gap that needs
    // host-owned storage surviving the subprocess, not a flag here.
    denyEverWritten: false,
    scanTruncated,
  });

  if (!result.deny) process.exit(0);

  fail(
    `mutation denied (${result.reasons.join(', ')}). Resume via host \`adlc handoff resume\` / repair, ` +
      `or continue in a fresh session. Agent shell cannot clear the deny-set.\n\n${recoveryDiagnostic(sessionId)}`
  );
}

/**
 * The recovery-command (or no-safe-session-id) tail every Hard-Degraded/deny
 * diagnostic message MUST include (spec §1.3) — not just a description of
 * why telemetry degraded, but the literal, copy-pasteable command itself.
 *
 * Round-5 review: this used to format via `api.formatRecoveryCommand` /
 * `api.RECOVERY_CLI_PATH` — the SAME dynamically-loaded, project-resolved
 * package whose failure to load or export what's expected is exactly what
 * every early fail() in `main()` is reporting when it appends this
 * diagnostic. A stale/incompatible install left the operator with a
 * generic, repo-relative "run the CLI manually" message that named no
 * absolute path `matchRecoveryCommand` would actually accept — stranding
 * them with only `pwd`. This now builds the diagnostic ENTIRELY from
 * trusted local code — `formatRecoveryCommand`/`formatNoSessionIdMessage`
 * above (twins of the package's own) and `resolveContextHandoffEntry` (a
 * pure, execution-free module-resolution lookup, not an `import()` of the
 * package) — the same trusted resolution `main()`'s exception check already
 * uses for the matcher itself, so the diagnostic and the exception it
 * describes can never disagree about where the CLI lives.
 */
export function recoveryDiagnostic(sessionId, { resolveEntry = resolveContextHandoffEntry } = {}) {
  // `resolveEntry` is injectable for one reason: the unresolved branch below
  // is unreachable in a test that runs on a machine where @adlc/cli happens
  // to be installed, and that branch is precisely the message issue #526
  // found stranding operators.
  const entry = resolveEntry({ projectRoot: process.cwd() });
  const trustedRecoveryCliPath = entry ? join(dirname(dirname(entry)), 'bin', 'handoff.mjs') : null;
  if (!trustedRecoveryCliPath) {
    return 'Recovery command unavailable: @adlc/context-handoff could not be resolved from this project, from this plugin, or from a global @adlc/cli install. Install it (npm install -g @adlc/cli) and re-run, then drive the operator recovery CLI with its own bin: handoff bypass|unlock|repair|write|resume. `pwd` remains usable regardless.';
  }
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    let interpreterPath = process.execPath;
    let scriptPath = trustedRecoveryCliPath;
    try {
      interpreterPath = realpathSync(interpreterPath);
    } catch {
      /* fall back to the unresolved path rather than throw from a diagnostic */
    }
    try {
      scriptPath = realpathSync(scriptPath);
    } catch {
      /* fall back to the unresolved path rather than throw from a diagnostic */
    }
    return formatRecoveryCommand({ interpreterPath, scriptPath, sessionId });
  }
  return formatNoSessionIdMessage();
}

// Only run as a hook when executed directly — the contract test imports this
// module for its pure exports and must not trigger a live stdin read.
//
// pathToFileURL, never `file://${argv[1]}`: a path containing a space (or any
// character a file URL percent-encodes, and every Windows path) would not match
// import.meta.url, so main() would silently never run and the hook would exit 0
// — reading as ALLOW. An enforcing gate that no-ops on an install path is worse
// than one that errors.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    // Enforcing hook — a crash must fail closed, never fall through to allow.
    fail(`handoff hook errored (${err?.message ?? 'unknown'}) — failing closed\n\n${recoveryDiagnostic(lastKnownSessionId)}`);
  });
}
