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

import { existsSync, readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadContextHandoff } from './handoff-resolve.mjs';
import { countToolCalls } from './adlc-build-gate.mjs';
import { resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';

function fail(message) {
  console.error(`adlc-handoff-gate: ${message}`);
  process.exit(2);
}

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

function fileSize(path) {
  try {
    const fd = openSync(path, 'r');
    try {
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  } catch {
    return -1;
  }
}

function tailBytes(path, maxBytes) {
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, size - length);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// countToolCalls comes from adlc-build-gate.mjs — the canonical Codex
// transcript counter, itself pinned to packages/build-gate by a drift test. A
// second hand-written regex here silently disagreed with it: it missed the
// `Writing|Editing|Created` prose tool-log form the real counter recognizes, so
// a deep session in that transcript shape reported depth 0 and never reached
// the band. Two counters over one transcript is one counter too many.

/**
 * Observe depth/bytes for evaluateBands. Thresholds live in
 * `@adlc/context-handoff`; nothing here compares against one.
 * An unreadable-but-present transcript yields NaN so the band classifier
 * treats it as invalid rather than as a healthy zero.
 *
 * `maxScanBytes` is the read window and is REQUIRED — the caller passes the
 * package's HARD_BYTES rather than a local copy. Scanning past the hard band
 * buys nothing (a transcript that large already denies on the bytes signal),
 * so the window and the band are the same number by construction; keeping a
 * second literal here would just be a threshold copy waiting to drift.
 *
 * @param {object} payload hook payload
 * @param {{ maxScanBytes: number, size?: Function, tail?: Function }} opts
 */
export function observeHandoffSignals(payload, { maxScanBytes, size = fileSize, tail = tailBytes }) {
  const observed = {};
  const tp = payload?.transcript_path;
  // No transcript field at all is an ABSENT signal: the band join ignores it, so
  // a harness that supplies no telemetry cannot hard-lock the repo.
  if (typeof tp !== 'string' || tp === '') return observed;
  // A path that WAS supplied but cannot be reached is a different thing — a
  // failed read of a signal that exists. Rotation, deletion, or a permission
  // error must not read as "no pressure" for a session that may be well past
  // the band. NaN is what the classifier treats as invalid, i.e. fail closed.
  if (!existsSync(tp)) {
    observed.bytes = Number.NaN;
    observed.depth = Number.NaN;
    return observed;
  }
  if (!Number.isFinite(maxScanBytes) || maxScanBytes <= 0) {
    // No usable window means the signal cannot be bounded — do not guess.
    observed.bytes = Number.NaN;
    observed.depth = Number.NaN;
    return observed;
  }

  const sessionBytes = size(tp);
  if (sessionBytes < 0) {
    observed.bytes = Number.NaN;
    observed.depth = Number.NaN;
    return observed;
  }
  observed.bytes = sessionBytes;

  let windowText;
  let truncated = false;
  if (sessionBytes > maxScanBytes) {
    windowText = tail(tp, maxScanBytes);
    truncated = true;
  } else {
    try {
      windowText = readFileSync(tp, 'utf8');
    } catch {
      windowText = null;
    }
  }
  if (windowText == null) {
    observed.depth = Number.NaN;
    return observed;
  }
  // A windowed read can only undercount tool calls, so keep depth fail-closed
  // when the transcript was truncated.
  observed.depth = truncated ? Number.POSITIVE_INFINITY : countToolCalls(windowText);
  return observed;
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

  // Before anything project-controlled can be imported.
  scrubSecrets();

  let payload = {};
  const raw = await stdinText();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      fail(`malformed hook payload JSON (${err.message}) — failing closed`);
    }
  }

  const api = await loadContextHandoff({ projectRoot: process.cwd() });
  if (!api) {
    fail(
      'cannot load @adlc/context-handoff — install @adlc/cli (or the workspace package) so D1-D3 can be evaluated; failing closed'
    );
  }
  for (const method of REQUIRED_API) {
    if (typeof api[method] !== 'function') {
      fail(`@adlc/context-handoff missing export: ${method} — failing closed`);
    }
  }
  if (!Number.isFinite(api.HARD_BYTES) || api.HARD_BYTES <= 0) {
    fail('@adlc/context-handoff missing export: HARD_BYTES — failing closed');
  }

  const sessionId = api.resolveHandoffSessionId({
    candidates: [payload.session_id, payload.sessionId],
    transcriptPath: payload.transcript_path,
  });

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

  const result = api.evaluateHandoffPreToolUse({
    root: process.cwd(),
    sessionId,
    observed: observeHandoffSignals(payload, { maxScanBytes: api.HARD_BYTES }),
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
    manifestKey: null,
    // A hook is a fresh process per call, so there is no in-memory D1 fact to
    // carry. When a marker write SUCCEEDS the sentinel records the session and
    // mutationGateInputFromLoad reconstructs stickiness from registeredSessions.
    // When the write FAILS there is nothing durable to reconstruct from, so a
    // later call whose band has cooled will not know — a residual gap that needs
    // host-owned storage surviving the subprocess, not a flag here.
    denyEverWritten: false,
  });

  if (!result.deny) process.exit(0);

  fail(
    `mutation denied (${result.reasons.join(', ')}). Resume via host \`adlc handoff resume\` / repair, ` +
      'or continue in a fresh session. Agent shell cannot clear the deny-set.'
  );
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
    fail(`handoff hook errored (${err?.message ?? 'unknown'}) — failing closed`);
  });
}
