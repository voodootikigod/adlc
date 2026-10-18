#!/usr/bin/env node
// ADLC rails-guard — GitHub Copilot CLI adapter.
//
// The rail-decision core below (path collection, shell classification, rail
// matching, active-ticket resolution) is a verbatim port of the canonical
// implementation shipped in plugins/adlc-codex/hooks/adlc-rails-guard.mjs,
// which is itself pinned to @adlc/core. plugins/adlc-copilot/test/shell-drift.test.mjs
// pins this file's inline shell classifier to packages/core/lib/shell.mjs so
// there is NO divergent rail re-implementation (issue #242, AC3).
//
// Only the I/O contract differs from codex, per the verified Copilot binary
// contract (Copilot CLI 1.0.73, app.js `Y3t` — see
// docs/integrations/copilot-probe-appendix.md):
//   * DENY  = print a NON-EMPTY JSON object `{ "reason": "…" }` to STDOUT and
//             exit 0 (the `reason` surfaces to the model as hookMessage).
//             NOT exit-2 and NOT `permissionDecision` (neither is honored by
//             the CLI). See fail() below.
//   * ALLOW = print nothing to stdout and exit 0.
//   * Copilot infra FAILS OPEN on a hook process crash/timeout/non-zero exit
//     (decision = undefined → tool proceeds). This adapter therefore NEVER
//     throws to the OS: every internal error is converted into a deny
//     (application-level fail-safe, see the process handlers below), so the
//     only residual fail-open window is an OS-level kill or the timeoutSec
//     budget — documented honestly in docs/integrations/copilot.md.
//   * Copilot stdin is camelCase `{ toolName, toolArgs(JSON string), cwd }`,
//     normalized into the internal `{ tool_name, tool_input }` shape by
//     normalizeCopilotPayload() before the shared collectors run.
//
// The shell classifier + path-extraction functions come from the GENERATED
// canonical module ./generated-shell.mjs (built from packages/core/lib/shell.mjs
// via scripts/generate-canonical-readers.mjs). This hook script cannot resolve
// npm packages at runtime, so it imports the generated sibling copy; a drift
// test (test/shell-drift.test.mjs) pins that wire-up and behavior against
// @adlc/core.
import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, relative, resolve, dirname, basename } from 'node:path';
import { loadTicketStoreReadOnly } from './generated-ticket-reader.mjs';
import {
  resolveActiveTicketId as resolveActiveTicketIdCanonical,
  resolveActiveTicketAgainst,
} from './generated-active-ticket.mjs';
import {
  collectPatchPaths,
  shellTokens,
  looksPathLike,
  looksBarePathLike,
  keyValuePath,
  hasUnquotedFileRedirect,
  shellHasMutation,
  shellHasOpaqueMutation,
  shellIsPositivelyReadOnly,
  shellHasWriteOption,
  shellChangesCwd,
  shellHasExpansion,
  collectShellPaths,
  classifyShellCommand,
} from './generated-shell.mjs';

export {
  collectPatchPaths,
  shellTokens,
  looksPathLike,
  looksBarePathLike,
  keyValuePath,
  hasUnquotedFileRedirect,
  shellHasMutation,
  shellHasOpaqueMutation,
  shellIsPositivelyReadOnly,
  shellHasWriteOption,
  shellChangesCwd,
  shellHasExpansion,
  collectShellPaths,
  classifyShellCommand,
};

function emitDeny(reason) {
  // Verified Copilot deny shape (1.0.73): non-empty object on stdout, exit 0.
  // Use a SYNCHRONOUS write to fd 1: process.stdout.write() to a pipe is async,
  // and process.exit() can truncate an unflushed buffer — a lost deny object is
  // read as empty stdout → allow → fail OPEN. writeSync guarantees the bytes land.
  try { writeSync(1, `${JSON.stringify({ reason })}\n`); } catch { /* fd closed — nothing more we can do */ }
  process.exit(0);
}

function fail(message) {
  emitDeny(`adlc-rails-guard: ${message}`);
}

function notice(message) {
  // Advisory only — stderr is not part of the Copilot hook decision (only
  // parsed stdout is). An allow is "no stdout"; keep these off stdout.
  console.error(`adlc-rails-guard: ${message}`);
}

// Application-level fail-safe: Copilot infra fails OPEN on a crashed hook, so a
// bug in this adapter must never silently let a rail edit through. Convert any
// unexpected throw/rejection into a deny instead of dying non-zero.
process.on('uncaughtException', (error) => {
  emitDeny(`adlc-rails-guard: internal error, denying to fail safe: ${error?.message ?? error}`);
});
process.on('unhandledRejection', (error) => {
  emitDeny(`adlc-rails-guard: internal error, denying to fail safe: ${error?.message ?? error}`);
});

/**
 * Map Copilot's camelCase preToolUse stdin ({ toolName, toolArgs, cwd }) onto
 * the internal { tool_name, tool_input } shape the shared collectors expect.
 * toolArgs is a JSON STRING and must be parsed; if it will not parse we leave
 * it in place so collectCommandText/collectPaths can still scan the raw text.
 */
function normalizeCopilotPayload(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const payload = { ...raw };
  const name = raw.toolName ?? raw.tool_name ?? raw.tool ?? raw.name;
  if (name && !payload.tool_name) payload.tool_name = name;
  let args = raw.toolArgs ?? raw.tool_input ?? raw.arguments ?? raw.input;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* keep the raw string for text scanning */ }
  }
  if (args !== undefined && payload.tool_input === undefined) payload.tool_input = args;
  return payload;
}

function parseJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') throw err;
    fail(`malformed JSON in ${path}: ${err.message}`);
  }
}

function readRequiredJson(path) {
  try {
    return parseJson(path);
  } catch (err) {
    if (err?.code === 'ENOENT') fail(`file not found: ${path}`);
    throw err;
  }
}


// The rail/scope glob matcher is a GENERATED verbatim copy of
// packages/core/lib/glob.mjs: this file is installed without node_modules, so it
// cannot import @adlc/core, and a hand-kept copy is what drifted before.
import { globMatch } from './generated-glob-match.mjs';

function loadTickets(path) {
  const data = readRequiredJson(path);
  if (!Array.isArray(data.tickets)) fail(`${path} must contain a tickets array`);
  const ids = new Set();
  const errors = [];
  for (const ticket of data.tickets) {
    if (!ticket || typeof ticket !== 'object') {
      errors.push('ticket is not an object');
      continue;
    }
    if (!ticket.id || typeof ticket.id !== 'string') errors.push('ticket missing string id');
    if (!ticket.title || typeof ticket.title !== 'string') errors.push(`${ticket.id ?? '?'}: missing string title`);
    if (ticket.rails !== undefined && !Array.isArray(ticket.rails)) errors.push(`${ticket.id}: rails must be an array`);
    if (ticket.id) {
      if (ids.has(ticket.id)) errors.push(`duplicate ticket id: ${ticket.id}`);
      ids.add(ticket.id);
    }
  }
  if (errors.length > 0) fail(`ticket file errors: ${errors.join('; ')}`);
  return data.tickets;
}

function collectPaths(value, out = new Set()) {
  if (typeof value === 'string') {
    collectPatchPaths(value, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['path', 'filePath', 'file_path', 'target', 'targetPath', 'target_path'].includes(key) && typeof child === 'string') {
      out.add(child);
    } else if (['paths', 'filePaths', 'file_paths'].includes(key) && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === 'string') out.add(item);
        else collectPaths(item, out);
      }
    } else if (key === 'input' && typeof child === 'string') {
      // `input` is overloaded across tool contracts: apply_patch-style tools
      // pass patch TEXT here, but adlc_prosecute's `input` (packages/cli/lib/
      // mcp-server.mjs) is a genuine relative file PATH, not patch text.
      // Collect both interpretations — collectPatchPaths finds nothing for a
      // bare filename (no `*** Add File:`-style line to match), and a real
      // patch body never parses as a bare path (looksPathLike/looksBarePathLike
      // reject embedded newlines), so this cannot double-count the same bytes.
      collectPatchPaths(child, out);
      if (looksPathLike(child) || looksBarePathLike(child)) out.add(child);
    } else {
      collectPaths(child, out);
    }
  }
  return out;
}

function collectCommandText(value, out = []) {
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

function firstShellWorkdir(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstShellWorkdir(item);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['workdir', 'cwd', 'workingDirectory', 'working_directory'].includes(key) && typeof child === 'string') {
      return child;
    }
    const found = firstShellWorkdir(child);
    if (found) return found;
  }
  return null;
}

function railMatchesPath(rail, path) {
  if (path === '' || path === '.') return true;
  if (path === '..' || path.startsWith('../')) return true;
  if (globMatch(rail, path)) return true;
  if (rail.endsWith('/**')) return path === rail.slice(0, -3);
  return false;
}

function toolName(payload) {
  return payload.tool_name ?? payload.toolName ?? payload.tool ?? payload.name ?? payload.recipient_name ?? '';
}

// #809: an EXACT whole-name allowlist of tools verified to never carry an
// editable-file argument, consulted only when a call reaches the terminal
// "no editable paths" branch. This narrows the false-positive surface for
// specific, verified-safe tools without weakening the fail-closed default
// for anything else — a tool NOT on this list, with zero collected paths,
// still denies exactly as before. `adlc_gate`/`adlc_prosecute` are this
// plugin's own MCP tools (packages/cli/lib/mcp-server.mjs — the only two
// this plugin ships); `todo_write`/`fetch` are common pathless planning/read
// tools with no file-mutation argument in their contract.
const NON_MUTATING_TOOL_NAMES = new Set(['adlc_gate', 'adlc_prosecute', 'todo_write', 'fetch']);

function isShellToolName(name) {
  return /(^|\.)(bash|shell|exec|exec_command|run_command|write_stdin)$/i.test(String(name));
}

function collectShellInvocations(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectShellInvocations(item, out);
    return out;
  }
  if (isShellToolName(toolName(value))) {
    const name = String(toolName(value));
    const workdir = firstShellWorkdir(value);
    for (const commandText of collectCommandText(value)) {
      out.push({ commandText, workdir, name });
    }
    return out;
  }
  for (const child of Object.values(value)) collectShellInvocations(child, out);
  return out;
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolve the active ticket id through the canonical pointer contract
 * (generated-active-ticket.mjs, generated from packages/tickets/lib/pointer.mjs).
 * This was a hand-rolled copy; it accepted `ticketId` while the claude-code and
 * build-gate copies did not, so the same pointer enforced here and silently
 * disabled enforcement there. Any denial fails closed.
 */
function resolveActiveTicketId(root) {
  const resolved = resolveActiveTicketIdCanonical({ root, env: process.env });
  if (!resolved.ok) fail(resolved.message);
  return { id: resolved.value?.id ?? undefined };
}

/**
 * The repository a hook decision is about.
 *
 * Copilot's preToolUse stdin carries `cwd` — the directory the tool call targets.
 * The hook PROCESS may start somewhere else (an older CLI, a `/cd`, a worktree
 * switch), and a repository read anchored on process.cwd() then finds no
 * pointer, prints "no current ticket selected" and ALLOWS — a silent fail-open
 * of this plugin's one enforcing gate (#811). So the payload names the
 * repository, and the process cwd is only the fallback for a payload that
 * carries no usable `cwd`. Same derivation as adlc-build-gate.mjs; the hooks
 * are self-contained, so each defines it.
 *
 * Pure on purpose: `fallback` is passed in by the caller, never read here.
 */
function payloadRoot(payload, fallback) {
  const cwd = payload?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? resolve(cwd) : fallback;
}

function safeRealpath(fp) {
  try {
    return realpathSync(fp);
  } catch {
    const parent = dirname(fp);
    if (parent === fp) return fp;
    try {
      return resolve(safeRealpath(parent), basename(fp));
    } catch {
      return fp;
    }
  }
}

function normalizePath(path, baseCwd = root) {
  const normalized = path.replaceAll('\\', '/');
  const absolute = safeRealpath(isAbsolute(normalized) ? normalized : resolve(baseCwd, normalized));
  const projectRoot = safeRealpath(root);
  const projectRelative = relative(projectRoot, absolute).replaceAll('\\', '/');
  return projectRelative.startsWith('..') ? normalized : projectRelative;
}

// Payload parsing happens FIRST: the payload names the repository (payloadRoot)
// that every ticket/pointer/store read below is about, so nothing below may run
// before it. A malformed payload is a deny, as before.
let payload = {};
const raw = await stdinText();
if (raw.trim()) {
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail(`malformed hook payload JSON: ${err.message}`);
  }
}
payload = normalizeCopilotPayload(payload);

const processCwd = process.cwd();
const root = payloadRoot(payload, processCwd);
if (safeRealpath(root) !== safeRealpath(processCwd)) {
  notice(`resolving the repository from the payload cwd ${root} (process cwd ${processCwd})`);
}

const explicitEnforcement = process.env.ADLC_P4_ENFORCEMENT;
if (explicitEnforcement === '0') {
  notice('P4 rail hook explicitly disabled');
  process.exit(0);
}
if (explicitEnforcement !== undefined && explicitEnforcement !== '1') {
  fail('ADLC_P4_ENFORCEMENT must be 0, 1, or unset');
}

const activeTicket = resolveActiveTicketId(root);
const ticketId = activeTicket.id;
if (!ticketId) {
  if (explicitEnforcement === '1') fail('ADLC_P4_ENFORCEMENT=1 but no active ticket source resolved');
  notice('P4 rail hook inactive: no current ticket selected');
  process.exit(0);
}

let snapshot;
try { snapshot = loadTicketStoreReadOnly({ root, env: process.env }); }
catch (error) { fail(`ticket store failed to load: ${error.message}`); }
const tickets = snapshot.tickets;

const ticket = tickets.find((t) => t.id === ticketId);
if (!ticket) fail(`unknown active ticket: ${ticketId}`);
// Re-resolve against the loaded store so the pinned ticketHash is verified by the
// same contract every other reader uses. allowLegacyPointer keeps the documented
// 1.x bridge: a pointer that pins no hash still resolves (this harness never
// required one), but a hash that IS present is always verified.
const activeAgainstStore = resolveActiveTicketAgainst(snapshot, { root, env: process.env, allowLegacyPointer: true });
if (!activeAgainstStore.ok) fail(activeAgainstStore.message);
const ticketsPath = process.env.ADLC_TICKET_STORE ?? process.env.ADLC_TICKETS ?? (snapshot.backend === 'directory' ? '.adlc/tickets' : '.adlc/tickets.json');
const declaredRails = ticket.rails ?? [];
if (explicitEnforcement !== '1' && ticket.completed === true) {
  notice(`P4 rail hook inactive: ticket ${ticketId} is completed`);
  process.exit(0);
}
if (declaredRails.length === 0) {
  if (explicitEnforcement === '1') fail(`ticket ${ticketId} has no rails`);
  notice(`P4 rail hook inactive: ticket ${ticketId} has no rails`);
  process.exit(0);
}
const rails = [...declaredRails, snapshot.backend === 'directory' ? '.adlc/tickets/**' : normalizePath(ticketsPath), '.adlc/current-ticket.json'];

const rawPaths = collectPaths(payload);
const paths = Array.from(rawPaths).map((path) => normalizePath(path));
const shellInvocations = collectShellInvocations(payload);
const shellTool = shellInvocations.length > 0;
let shellMutating = false;
let cwdChangingShellMutation = false;
let expandingShellMutation = false;
if (shellTool) {
  for (const { commandText, workdir, name } of shellInvocations) {
    if (/(^|\.)write_stdin$/i.test(name)) {
      if (commandText.trim() === '') continue;
      fail('interactive shell stdin payload cannot be verified during active P4');
    }
    const commandMutating = shellHasMutation(commandText);
    if (!commandMutating && shellIsPositivelyReadOnly(commandText)) {
      if (shellHasWriteOption(commandText)) {
        fail('read-only shell payload uses an output option; use a structured edit tool or literal path-transparent mutation');
      }
      continue;
    }

    if (!commandMutating) {
      fail('shell payload is neither a known read-only command nor a path-transparent mutation');
    }
    if (shellHasOpaqueMutation(commandText)) {
      fail('mutating shell payload uses an opaque command; use a structured edit tool or literal path-transparent mutation');
    }
    shellMutating = true;
    if (shellChangesCwd(commandText)) cwdChangingShellMutation = true;
    if (shellHasExpansion(commandText)) expandingShellMutation = true;
    const commandPaths = new Set();
    collectShellPaths(commandText, commandPaths);
    if (commandPaths.size === 0) {
      fail('mutating shell payload did not include literal editable paths');
    }
    const shellBaseCwd = workdir ? resolve(root, workdir) : root;
    for (const path of commandPaths) paths.push(normalizePath(path, shellBaseCwd));
  }
}

if (cwdChangingShellMutation) {
  fail('mutating shell payload changes cwd; use a structured edit tool or project-relative shell target paths');
}
if (expandingShellMutation) {
  fail('mutating shell payload uses shell expansion; use a structured edit tool or literal project-relative shell target paths');
}

if (paths.length === 0) {
  if (shellTool && !shellMutating && shellInvocations.length > 0 && shellInvocations.every(({ commandText }) => shellIsPositivelyReadOnly(commandText))) {
    notice('shell command has no editable rail targets');
    process.exit(0);
  }
  if (!shellTool && NON_MUTATING_TOOL_NAMES.has(String(toolName(payload)))) {
    notice(`non-mutating tool "${toolName(payload)}" has no editable rail targets`);
    process.exit(0);
  }
  fail(shellTool ? 'shell payload did not include literal editable paths or a known read-only command' : 'active hook payload did not include any editable paths');
}
const blocked = paths.filter((path) => rails.some((rail) => railMatchesPath(rail, path)));
if (blocked.length > 0) fail(`blocked rail edit for ${ticketId}: ${blocked.join(', ')}`);

process.exit(0);
