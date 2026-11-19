#!/usr/bin/env node
// Shell classification and path-extraction functions are imported from
// ./generated-shell.mjs (generated from packages/core/lib/shell.mjs by
// scripts/ticket-readers/generate.mjs) so this hook runs standalone without
// resolving @adlc/core from node_modules at runtime.
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTicketStoreReadOnly } from './generated-ticket-reader.mjs';
import { resolveRailPath } from './generated-railpath.mjs';
import {
  canonicalizePath,
  findInnermostCheckoutRoot,
  inspectGitCheckout,
  preferInnermostCheckout,
  isPathInside,
  extractAllToolWorkdirs,
  hasConflictingToolWorkdirs,
} from './generated-workspace-root.mjs';
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
import {
  toolNameOf,
  isRecoveryEligibleToolName,
  isBareInspectionPwd,
  matchRecoveryCommand,
  resolveTrustedBinary,
  recordRecoveryUnderBand,
  resolveHandoffSessionIdLocal,
} from './adlc-handoff-gate.mjs';
import { resolveContextHandoffEntry } from './handoff-resolve.mjs';

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
} from './generated-shell.mjs';

function fail(message) {
  console.error(`adlc-rails-guard: ${message}`);
  process.exit(2);
}

function notice(message) {
  console.error(`adlc-rails-guard: ${message}`);
}

// The rail/scope glob matcher is a GENERATED verbatim copy of
// packages/core/lib/glob.mjs: this file is installed without node_modules, so it
// cannot import @adlc/core, and a hand-kept copy is what drifted before.
import { globMatch } from './generated-glob-match.mjs';

function collectStructuredTargets(
  value,
  defaultBase,
  rootPayload = value,
  inheritedWorkdirs = [],
  out = []
) {
  const emitWithWorkdirs = (raw, workdirs) => {
    if (!raw.trim()) return;
    const [firstWorkdir] = workdirs;
    const base = firstWorkdir ? resolve(defaultBase, firstWorkdir) : defaultBase;
    const candidateBases =
      workdirs.length > 0 ? workdirs.map((wd) => resolve(defaultBase, wd)) : [defaultBase];
    out.push({
      raw,
      base,
      abs: resolve(base, raw),
      probeAbs: candidateBases.map((b) => resolve(b, raw)),
      isShellVerb: false,
    });
  };
  if (typeof value === 'string') {
    const patches = new Set();
    collectPatchPaths(value, patches);
    for (const p of patches) emitWithWorkdirs(p, inheritedWorkdirs);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredTargets(item, defaultBase, rootPayload, inheritedWorkdirs, out);
    }
    return out;
  }
  const directWorkdirs = extractAllToolWorkdirs(stripEnvelopeCwd(value, rootPayload));
  const activeWorkdirs = directWorkdirs.length > 0 ? directWorkdirs : inheritedWorkdirs;
  const emitFromNode = (raw) => emitWithWorkdirs(raw, activeWorkdirs);
  for (const [key, child] of Object.entries(value)) {
    if (['path', 'filePath', 'file_path', 'target', 'targetPath', 'target_path'].includes(key) && typeof child === 'string') {
      emitFromNode(child);
    } else if (['paths', 'filePaths', 'file_paths'].includes(key) && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === 'string') emitFromNode(item);
        else collectStructuredTargets(item, defaultBase, rootPayload, activeWorkdirs, out);
      }
    } else if (['command', 'cmd', 'patch', 'input'].includes(key) && typeof child === 'string') {
      const patches = new Set();
      collectPatchPaths(child, patches);
      for (const p of patches) emitFromNode(p);
    } else {
      collectStructuredTargets(child, defaultBase, rootPayload, activeWorkdirs, out);
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

function stripEnvelopeCwd(value, rootPayload) {
  if (value !== rootPayload || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { cwd: _envelopeCwd, ...rest } = value;
  return rest;
}

function hasShellWorkdirConflict(value, baseDir, rootPayload = value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasShellWorkdirConflict(item, baseDir, rootPayload));
  }
  if (hasConflictingToolWorkdirs(stripEnvelopeCwd(value, rootPayload), baseDir)) {
    return true;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && hasShellWorkdirConflict(child, baseDir, rootPayload)) {
      return true;
    }
  }
  return false;
}

function allShellWorkdirs(value, rootPayload = value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) allShellWorkdirs(item, rootPayload, out);
    return out;
  }
  for (const wd of extractAllToolWorkdirs(stripEnvelopeCwd(value, rootPayload))) {
    if (!out.includes(wd)) out.push(wd);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') allShellWorkdirs(child, rootPayload, out);
  }
  return out;
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

function isShellToolName(name) {
  return /(^|\.)(bash|shell|exec|exec_command|run_command|run_shell_command|run_terminal_cmd|write_stdin)$/i.test(String(name));
}

function collectShellInvocations(value, out = [], rootPayload = value) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectShellInvocations(item, out, rootPayload);
    return out;
  }
  if (isShellToolName(toolName(value))) {
    const name = String(toolName(value));
    const workdirs = allShellWorkdirs(value, rootPayload);
    const workdir = workdirs[0] ?? null;
    for (const commandText of collectCommandText(value)) {
      out.push({ commandText, workdir, workdirs, name });
    }
    return out;
  }
  for (const child of Object.values(value)) collectShellInvocations(child, out, rootPayload);
  return out;
}

/**
 * Deepest nesting of arrays/objects the hook will classify. The payload is
 * agent-controlled, and every collector below walks it recursively; a payload
 * nested far beyond any real tool call blew the stack in that walk and the
 * resulting uncaught RangeError exited 1 — a NON-blocking error in Codex's
 * PreToolUse convention, so the edit went through. Anything deeper than this
 * is denied before any collector sees it. 64 is two orders of magnitude above
 * the deepest payload a real tool call produces (tool_input → paths → item).
 */
export const MAX_PAYLOAD_DEPTH = 64;

/** An array or a non-null object — the only values that add a nesting level. */
function isContainer(value) {
  return value !== null && typeof value === 'object';
}

/**
 * True when `value` nests arrays/objects deeper than `limit` levels. A container
 * counts as one level, scalars as none, so `{}` is depth 1 and exceeds limit 0.
 * ITERATIVE on purpose: this is the guard that keeps a hostile depth away from
 * the recursive collectors, so it cannot itself be a recursive walk.
 * Pure — reads `value`, never mutates it.
 */
export function exceedsDepth(value, limit) {
  // Only containers ever enter the stack, so the pop side has nothing to
  // re-check: one filter, applied at the root and at every push.
  if (!isContainer(value)) return false;
  const stack = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (depth > limit) return true;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (isContainer(child)) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
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
function resolveActiveTicketId(root = process.cwd(), env = process.env) {
  const resolved = resolveActiveTicketIdCanonical({ root, env });
  if (!resolved.ok) fail(resolved.message);
  return { id: resolved.value?.id ?? undefined };
}

function normalizePath(path, baseCwd = process.cwd(), repoRoot = baseCwd) {
  const normalized = path.replaceAll('\\', '/');
  const candidate = resolve(baseCwd, normalized);
  const projectRelative = resolveRailPath(candidate, repoRoot);
  if (!projectRelative.startsWith('..')) return projectRelative;
  return isAbsolute(normalized) || isPathInside(baseCwd, repoRoot) ? normalized : projectRelative;
}

// Everything below runs inside main() so that an uncaught throw anywhere in it
// DENIES (exit 2) instead of crashing with exit 1, which Codex treats as a
// non-blocking error and lets the tool call proceed. The body keeps its
// original column-0 layout: it was top-level code before being wrapped, and a
// whole-body re-indent would bury the behavioural change under whitespace.
async function main() {
// Payload parsing happens FIRST, before ANY ticket/pointer/rails resolution
// below — see the Recovery/Inspection Exception block immediately following
// for why. It must not be moved back down past that block.
let payload = {};
const raw = await stdinText();
if (raw.trim()) {
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail(`malformed hook payload JSON: ${err.message}`);
  }
}
if (exceedsDepth(payload, MAX_PAYLOAD_DEPTH)) {
  fail(`hook payload nesting exceeds ${MAX_PAYLOAD_DEPTH} levels — refusing to classify it`);
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

const toolCwd =
  typeof payload?.cwd === 'string' && payload.cwd.trim() !== ''
    ? resolve(payload.cwd)
    : process.cwd();
const rawStoreOverride = process.env.ADLC_TICKET_STORE ?? process.env.ADLC_TICKETS ?? null;
const storeOverride = sanitizeDiscoveryStoreOverride(rawStoreOverride, toolCwd, process.cwd());
const root = findInnermostCheckoutRoot(toolCwd, { storeOverride, preserveSpelling: true }) ?? toolCwd;

// Recovery Exception & Inspection Bash Exception (context-rot-threshold-
// calibration spec §1.3), applied to THIS gate too — evaluated before
// EVERYTHING else in this file, including active-ticket resolution and
// ticket-store loading, not just the shell-classification logic further
// down. This gate runs FIRST in hooks.json's PreToolUse pipeline
// (rails-guard, then build-gate, then handoff-gate) for every shell tool
// identity. Two independent lockout causes were found and fixed here in
// sequence: (1) the shell classifier has no concept of the recovery CLI's
// argument shape — a bypass/unlock/repair/write/resume invocation is
// neither a recognized read-only command nor a recognized path-transparent
// mutation, so it was denied by that classifier; (2) even after this check
// was added AFTER active-ticket/store resolution, a corrupt pointer, an
// unreadable/malformed ticket store, an unknown ticket id, or a hash
// mismatch would `fail()` during THAT resolution — before this check ever
// ran — reproducing the identical total-lockout failure through the
// gate's OWN state-validation path instead of its shell classifier. Moving
// this block to run on nothing but the raw stdin payload closes both.
// Reuses the same trusted, package-independent matcher as the other two
// gates (imported from the sibling adlc-handoff-gate.mjs — a plugin-owned,
// trusted file, never the dynamically-loaded project-resolved package), so
// all three gates share one definition of what an authorized
// recovery/inspection command is.
{
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
      const entry = resolveContextHandoffEntry({ projectRoot: root });
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
            cwd: root,
          });
          process.exit(0); // allow — never gated on the audit record above succeeding
        }
      }
    }
  }
}

const explicitEnforcement = process.env.ADLC_P4_ENFORCEMENT;
if (explicitEnforcement === '0') {
  notice('P4 rail hook explicitly disabled');
  process.exit(0);
}
if (explicitEnforcement !== undefined && explicitEnforcement !== '1') {
  fail('ADLC_P4_ENFORCEMENT must be 0, 1, or unset');
}

const structuredTargets = collectStructuredTargets(payload, toolCwd, payload);
const allPayloadWorkdirs = allShellWorkdirs(payload, payload).map((wd) => resolve(toolCwd, wd));
const shellInvocations = collectShellInvocations(payload);
const shellTool = shellInvocations.length > 0;
const nestedProbeStoreOverride =
  storeOverride &&
  ((!isAbsolute(storeOverride) &&
    (!isPathInside(resolve(root, storeOverride), root) || !existsSync(resolve(root, storeOverride)))) ||
    (isAbsolute(storeOverride) && isPathInside(storeOverride, root)))
    ? null
    : storeOverride;
const foreignStoreOverride =
  storeOverride && isAbsolute(storeOverride) && !isPathInside(storeOverride, root)
    ? storeOverride
    : null;

function envForCheckout(checkoutRoot) {
  const next = { ...process.env };
  const sameAsPrimary = canonicalizePath(resolve(checkoutRoot)) === canonicalizePath(resolve(root));
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
  if (!sameAsPrimary && (!isPathInside(checkoutRoot, root) || existsSync(join(checkoutRoot, '.adlc', 'current-ticket.json')))) {
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
      (sameAsPrimary || !isPathInside(trimmed, root)) &&
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

function loadCheckoutRails(checkoutRoot) {
  const checkoutEnv = envForCheckout(checkoutRoot);
  const activeTicket = resolveActiveTicketId(checkoutRoot, checkoutEnv);
  const ticketId = activeTicket.id;
  if (!ticketId) return { active: false, reason: 'no-ticket' };
  let snapshot;
  try { snapshot = loadTicketStoreReadOnly({ root: checkoutRoot, env: checkoutEnv }); }
  catch (error) { fail(`ticket store failed to load: ${error.message}`); }
  const ticket = snapshot.tickets.find((t) => t.id === ticketId);
  if (!ticket) fail(`unknown active ticket: ${ticketId}`);
  const activeAgainstStore = resolveActiveTicketAgainst(snapshot, { root: checkoutRoot, env: checkoutEnv, allowLegacyPointer: true });
  if (!activeAgainstStore.ok) fail(activeAgainstStore.message);
  const ticketsPath = checkoutEnv.ADLC_TICKET_STORE ?? checkoutEnv.ADLC_TICKETS ?? (snapshot.backend === 'directory' ? '.adlc/tickets' : '.adlc/tickets.json');
  const declaredRails = ticket.rails ?? [];
  if (explicitEnforcement !== '1' && ticket.completed === true) {
    return { active: false, reason: 'completed', ticketId };
  }
  if (declaredRails.length === 0) {
    return { active: false, reason: 'no-rails', ticketId };
  }
  const rails = [
    ...declaredRails,
    snapshot.backend === 'directory' ? '.adlc/tickets/**' : normalizePath(ticketsPath, checkoutRoot, checkoutRoot),
    '.adlc/current-ticket.json',
  ];
  return { active: true, ticketId, rails };
}

const primaryState = loadCheckoutRails(root);
const shellProbePaths = [];
for (const { commandText, workdirs } of shellInvocations) {
  const sp = new Set();
  collectShellPaths(commandText, sp);
  const candidateWorkdirs = workdirs && workdirs.length > 0 ? workdirs : [null];
  for (const wd of candidateWorkdirs) {
    const shellBase = wd ? resolve(toolCwd, wd) : toolCwd;
    shellProbePaths.push(shellBase);
    for (const p of sp) shellProbePaths.push(resolve(shellBase, p));
  }
}
const absProbeTargets = [
  ...structuredTargets.flatMap((t) => t.probeAbs),
  ...allPayloadWorkdirs,
  ...shellProbePaths,
];
const nestedRoots = new Set();
for (const absTarget of absProbeTargets) {
  const candidateRoot = isPathInside(absTarget, root)
    ? preferInnermostCheckout(root, [absTarget], {
        storeOverride: nestedProbeStoreOverride,
        allowFileStart: true,
        preserveSpelling: true,
      })
    : findInnermostCheckoutRoot(absTarget, {
        storeOverride: foreignStoreOverride,
        allowFileStart: true,
        requireStore: true,
        preserveSpelling: true,
      });
  if (candidateRoot && candidateRoot !== root) nestedRoots.add(candidateRoot);
}
const allNestedStates = new Map();
const nestedStates = new Map();
for (const nr of nestedRoots) {
  const st = loadCheckoutRails(nr);
  allNestedStates.set(nr, st);
  if (st.active) nestedStates.set(nr, st);
}

if (!primaryState.active && nestedStates.size === 0) {
  if (explicitEnforcement === '1') {
    for (const st of allNestedStates.values()) {
      if (st.reason === 'no-ticket') fail('ADLC_P4_ENFORCEMENT=1 but no active ticket source resolved');
      if (st.reason === 'no-rails') fail(`ticket ${st.ticketId} has no rails`);
    }
  }
  if (primaryState.reason === 'no-ticket') {
    if (explicitEnforcement === '1') fail('ADLC_P4_ENFORCEMENT=1 but no active ticket source resolved');
    notice('P4 rail hook inactive: no current ticket selected');
    process.exit(0);
  }
  if (primaryState.reason === 'completed') {
    notice(`P4 rail hook inactive: ticket ${primaryState.ticketId} is completed`);
    process.exit(0);
  }
  if (explicitEnforcement === '1') fail(`ticket ${primaryState.ticketId} has no rails`);
  notice(`P4 rail hook inactive: ticket ${primaryState.ticketId} has no rails`);
  process.exit(0);
}

if (hasShellWorkdirConflict(payload, toolCwd)) {
  fail('shell payload specifies conflicting working directories');
}

const seenStructured = new Set();
const resolvedTargets = [];
for (const entry of structuredTargets) {
  const key = `${entry.base}\0${entry.raw}`;
  if (seenStructured.has(key)) continue;
  seenStructured.add(key);
  resolvedTargets.push({
    raw: entry.raw,
    base: entry.base,
    abs: entry.abs,
    isShellVerb: false,
  });
}
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
    const firstVerb = shellTokens(commandText)[0] ?? '';
    const shellBaseCwd = workdir ? resolve(toolCwd, workdir) : toolCwd;
    for (const path of commandPaths) {
      resolvedTargets.push({
        raw: path,
        base: shellBaseCwd,
        abs: resolve(shellBaseCwd, path),
        isShellVerb: path === firstVerb && !looksPathLike(path),
      });
    }
  }
}

if (cwdChangingShellMutation) {
  fail('mutating shell payload changes cwd; use a structured edit tool or project-relative shell target paths');
}
if (expandingShellMutation) {
  fail('mutating shell payload uses shell expansion; use a structured edit tool or literal project-relative shell target paths');
}

if (resolvedTargets.length === 0) {
  if (shellTool && !shellMutating && shellInvocations.length > 0 && shellInvocations.every(({ commandText }) => shellIsPositivelyReadOnly(commandText))) {
    notice('shell command has no editable rail targets');
    process.exit(0);
  }
  fail(shellTool ? 'shell payload did not include literal editable paths or a known read-only command' : 'active hook payload did not include any editable paths');
}

const delegatedRoots = Array.from(nestedRoots).filter(
  (nr) => isPathInside(nr, root) || nestedStates.has(nr)
);
const primaryTargets = resolvedTargets.filter(({ abs }) => !delegatedRoots.some((nr) => isPathInside(abs, nr)));
if (primaryState.active) {
  const primaryPaths = primaryTargets.map(({ raw, base }) => normalizePath(raw, base, root));
  const blocked = primaryPaths.filter((path) => primaryState.rails.some((rail) => railMatchesPath(rail, path)));
  if (blocked.length > 0) fail(`blocked rail edit for ${primaryState.ticketId}: ${blocked.join(', ')}`);
}
for (const [nr, st] of allNestedStates.entries()) {
  const nestedTargets = resolvedTargets.filter(({ abs }) => isPathInside(abs, nr));
  if (nestedTargets.length === 0) continue;
  if (st.active) {
    const nestedPaths = nestedTargets.map(({ raw, base }) => normalizePath(raw, base, nr));
    const blocked = nestedPaths.filter((path) => st.rails.some((rail) => railMatchesPath(rail, path)));
    if (blocked.length > 0) fail(`blocked rail edit for ${st.ticketId}: ${blocked.join(', ')}`);
  } else if (explicitEnforcement === '1' && nestedTargets.some((t) => !t.isShellVerb)) {
    if (st.reason === 'no-ticket') fail('ADLC_P4_ENFORCEMENT=1 but no active ticket source resolved');
    if (st.reason === 'no-rails') fail(`ticket ${st.ticketId} has no rails`);
  }
}
if (primaryTargets.some((t) => !t.isShellVerb) && !primaryState.active && explicitEnforcement === '1') {
  if (primaryState.reason === 'no-ticket') fail('ADLC_P4_ENFORCEMENT=1 but no active ticket source resolved');
  if (primaryState.reason === 'no-rails') fail(`ticket ${primaryState.ticketId} has no rails`);
}

process.exit(0);
}

// pathToFileURL, never `file://${argv[1]}`: Node percent-encodes import.meta.url
// (a space becomes %20) but a hand-built template string does not, so an install
// path with a space would make this comparison always false and main() would
// never run — exit 0, allow, unconditionally.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    // Enforcing hook — a crash must fail closed, never fall through to allow.
    fail(`rails guard errored (${err?.message ?? 'unknown'}) — denying to fail closed`);
  });
}
