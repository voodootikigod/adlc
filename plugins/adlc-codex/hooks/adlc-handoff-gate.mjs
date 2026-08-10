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

import { loadContextHandoff } from './handoff-resolve.mjs';
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

function countToolCalls(text) {
  const matches = String(text ?? '').match(/"type"\s*:\s*"tool_use"|"type"\s*:\s*"function_call"/g);
  return matches ? matches.length : 0;
}

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
  if (typeof tp !== 'string' || tp === '' || !existsSync(tp)) return observed;
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

async function main() {
  if (!existsSync('.adlc')) process.exit(0); // not an ADLC repo → allow

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
  const isBash = isShellToolName(name);
  const bashCommand = isBash ? collectCommandText(payload).join('\n') : '';
  const editRelPaths = isBash
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
  });

  if (!result.deny) process.exit(0);

  fail(
    `mutation denied (${result.reasons.join(', ')}). Resume via host \`adlc handoff resume\` / repair, ` +
      'or continue in a fresh session. Agent shell cannot clear the deny-set.'
  );
}

// Only run as a hook when executed directly — the contract test imports this
// module for its pure exports and must not trigger a live stdin read.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    // Enforcing hook — a crash must fail closed, never fall through to allow.
    fail(`handoff hook errored (${err?.message ?? 'unknown'}) — failing closed`);
  });
}
