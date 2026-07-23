// rails-checker.mjs — the ADLC rail-enforcement decision for Cursor.
//
// This is a THIN adapter: every rail/glob/ticket primitive is delegated to
// @adlc/core (the single source of truth, per ADR 0006 / ADR 0004). It must NOT
// re-implement glob or ticket loading. The only non-core logic here is the
// sibling-hook enforcement contract (active-ticket resolution, phase gating,
// trust-root freeze) that adlc-opencode and adlc-codex already implement, plus a
// Cursor-specific tool classifier. The Cursor wire-format mapping (preToolUse
// stdin/stdout) lives in hooks/adlc-rails-guard.mjs; this file is editor-agnostic.

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { globMatch, TICKET_TRUST_ROOT_RAILS } from '@adlc/core';
import { detectTicketStore } from '@adlc/tickets';
import {
  resolveActiveTicketAgainst,
  resolveActiveTicketId as resolveActiveTicketIdCanonical,
} from './generated-active-ticket.mjs';

// The ticket file and the active-ticket pointer are the rail trust root: they are
// frozen whenever enforcement is active, even if no ticket declares them, so the
// rail set cannot be quietly edited away. Mirrors adlc-opencode/rails-checker.mjs.
export const TRUST_ROOT_RAILS = [...TICKET_TRUST_ROOT_RAILS];

// Cursor's structured file-mutation tools (normalized to lowercase, non-alpha
// stripped). Cursor exposes Write/Edit/MultiEdit/search_replace/delete_file-style
// tools to the agent. We classify a tool as MUTATING if its normalized name
// contains any of these substrings — note "replace" so search_replace/str_replace
// classify as mutating even though they also contain the read word "search".
// Shell writes are intentionally NOT gated in-session (Turing-complete shell);
// they fall to the CI diff gate.
export const MUTATING_TOOL_HINTS = ['write', 'edit', 'replace', 'patch', 'create', 'delete', 'remove', 'rename', 'move', 'apply', 'insert', 'append'];

// The Cursor preToolUse hook is wired with a catch-all matcher (".*") so EVERY
// tool call reaches the guard and the classifier is the single decision point —
// read-only tools return allow immediately, known mutators are checked, and an
// unrecognized tool ('other') carrying a rail path FAILS CLOSED. Defined in the
// dependency-free constants module (so the scaffolder can read it without pulling
// @adlc/core) and re-exported here for the hook/test importers.
export { PRETOOL_MATCHER } from './constants.mjs';

// Known pure-read tools (WHOLE normalized token — never substring). Only these
// short-circuit to "allow"; everything unrecognized falls through to "other",
// which checkRail treats as a checked mutation (FAIL CLOSED) so a novel or
// disguised edit tool can't slip a rail write past the guard. Reads of a frozen
// rail are fine, but we list reads explicitly rather than guessing by substring
// (substring matching let "frobnicate" match "cat" and "search_replace" match
// "search" — see ADR 0006 / the P5 prosecution that caught it).
export const PURE_READS = new Set([
  'read', 'readfile', 'readlints', 'grep', 'grepsearch', 'glob', 'globsearch',
  'codebasesearch', 'semanticsearch', 'filesearch', 'list', 'listdir', 'ls',
  'cat', 'view', 'viewfile', 'webfetch', 'websearch', 'fetch', 'fetchrules', 'search',
]);

/** Normalize a raw Cursor tool name to a lowercase alpha token for classification. */
export function normalizeToolName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

// Shell / terminal execution tools. These run a Turing-complete command string, not
// a structured file edit, so they are INTENTIONALLY not rail-gated in-session
// (their writes fall to the CI gate). They must be recognized so the no-path
// fail-closed branch — meant for opaque *structured* mutators — doesn't deny a
// normal `npm test`/build command and break the P4 workflow.
// EXACT whole normalized names of shell-execution tools. The shell exemption used
// by the no-path fail-closed branch matches ONLY these — never a substring or even
// a token. A token/substring predicate is unsafe here: a novel structured mutator
// named `terminal_modify` or `shell_set` (whose verb isn't in MUTATING_TOOL_HINTS,
// so it classifies as 'other') would carry a shell token and be waved through. An
// unrecognized shell tool name not in this set fails CLOSED under enforcement — the
// safe direction (a blocked command is visible and reportable; a silent mutator
// bypass is not). Real Cursor/agent shell tools are a small known set; extend here.
const SHELL_TOOL_NAMES = new Set([
  'bash', 'sh', 'zsh', 'fish', 'shell', 'terminal', 'cmd', 'powershell', 'pwsh', 'console',
  'exec', 'run', 'runcommand', 'runcmd', 'runterminalcmd', 'runterminalcommand',
  'runinterminal', 'runinterminalcommand', 'runshell', 'shellexec', 'shellcommand',
  'executecommand', 'execcommand', 'executecommandline', 'execcommandline',
  'executeshell', 'executeterminalcommand', 'terminalcmd', 'terminalcommand',
]);

/**
 * True ONLY for a recognized shell/terminal execution tool (exact whole-name match
 * after normalization). Used by the no-path exemption, which must NOT be fooled by a
 * structured mutator whose name merely contains a shell word. Mutating classification
 * also wins first in the caller, so `terminal_edit` is denied regardless.
 */
export function isShellTool(name) {
  return SHELL_TOOL_NAMES.has(normalizeToolName(name));
}

/**
 * Classify a Cursor tool name: 'mutating' | 'readonly' | 'other'.
 *
 * Order is load-bearing and FAIL-CLOSED:
 *  1. mutating hints (substring) win first — so "search_replace" (contains
 *     "replace") is mutating despite also containing "search";
 *  2. then known pure reads (whole token) are allowed;
 *  3. everything else is 'other', which checkRail CHECKS (treats as a mutation),
 *     so an unrecognized tool carrying a rail path is denied, not waved through.
 */
export function classifyTool(name) {
  const n = normalizeToolName(name);
  if (!n) return 'other';
  if (MUTATING_TOOL_HINTS.some((h) => n.includes(h))) return 'mutating';
  if (PURE_READS.has(n)) return 'readonly';
  return 'other';
}

/** Canonicalize a path to a forward-slash path relative to the repo root (lexical). */
export function canonicalizePath(filePath, root) {
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  return relative(root, abs).split('\\').join('/');
}

function realpathOr(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Symlink-aware canonicalization (security-relevant): resolve symlinks on the
 * target and on its existing parent segments before comparing to the frozen rail
 * set, so a symlink whose real target is a frozen rail cannot slip a write past a
 * lexical name check. Falls back to the lexical path for anything unresolvable.
 */
export function resolveRailPath(filePath, root) {
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  let resolved;
  if (existsSync(abs)) {
    resolved = realpathOr(abs);
  } else {
    // The file may not exist yet (a `write` creating it) and several parent
    // segments may also be missing. Walk up to the DEEPEST EXISTING ancestor,
    // realpath THAT (catching a symlinked ancestor like repoB/link -> repoA), then
    // re-append the not-yet-existing tail. A single-level dirname would miss a
    // symlink two or more levels above a new file.
    const tail = [];
    let cur = abs;
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) break; // filesystem root
      tail.unshift(basename(cur));
      cur = parent;
    }
    resolved = tail.length ? join(realpathOr(cur), ...tail) : realpathOr(cur);
  }
  return relative(realpathOr(root), resolved).split('\\').join('/');
}

/**
 * Resolve the active ticket id from process.env.ADLC_TICKET OR
 * .adlc/current-ticket.json. If both are set and disagree, that is a tamper
 * signal — return { conflict: true } so the caller fails closed.
 *
 * Identity-only (used by advisory stop-audit). Rail enforcement uses
 * `railPreconditions`, which applies `resolveActiveTicketAgainst` with
 * `allowLegacyPointer: true` (T64) for hash/store fail-closed outcomes.
 */
export function resolveActiveTicketId(root, env) {
  const resolved = resolveActiveTicketIdCanonical({ root, env });
  // conflict: true = fail closed. Beyond an ADLC_TICKET-vs-pointer disagreement it
  // now also covers an unparseable pointer AND an object pointer whose id key is
  // unrecognized — the latter used to read as "no active ticket" and ALLOW.
  if (!resolved.ok) return { id: null, conflict: true, code: resolved.code, message: resolved.message };
  return { id: resolved.value?.id ?? null, conflict: false };
}

/**
 * Evaluate the rail-state PRECONDITIONS (independent of any specific path) so that
 * both the path-bearing `checkRail` and the adapter's no-path branch make the SAME
 * no-op / fail-closed / enforcing decision and cannot drift.
 *
 * Returns one of:
 *  - { state: 'inactive', reason } — enforcement off, repo not initialized, or no
 *    active ticket → the gate is a no-op (allow);
 *  - { state: 'deny', reason } — a conflict, corrupt/unloadable store, an
 *    active ticket that isn't found, or a malformed rail entry → fail closed;
 *  - { state: 'active', rails, activeId } — enforcing with a valid ticket + rails.
 */
export function railPreconditions({ root = process.cwd(), env = process.env } = {}) {
  if (env.ADLC_P4_ENFORCEMENT !== '1') {
    return { state: 'inactive', reason: 'enforcement inactive (ADLC_P4_ENFORCEMENT !== "1")' };
  }

  let snapshot;
  try {
    snapshot = detectTicketStore({
      root,
      ticketStore: env.ADLC_TICKET_STORE,
      legacyTickets: env.ADLC_TICKETS,
      env,
    }).load();
  } catch (err) {
    if (err?.code === 'STORE_NOT_FOUND') {
      return { state: 'inactive', reason: 'repo not ADLC-initialized (no supported ticket store)' };
    }
    return {
      state: 'deny',
      reason: `ticket store failed to load (${err?.code ?? 'error'}: ${err?.message ?? err}) — failing closed`,
    };
  }

  const against = resolveActiveTicketAgainst(snapshot, { root, env, allowLegacyPointer: true });
  if (!against.ok) {
    return {
      state: 'deny',
      reason: against.message ?? 'conflicting active-ticket signal (ADLC_TICKET vs .adlc/current-ticket.json)',
    };
  }
  if (!against.value) {
    return { state: 'inactive', reason: 'no active ticket resolved' };
  }

  const ticket = against.value.ticket;
  const declaredRails = ticket.rails ?? [];
  // core validates rails is an array but NOT its element types; a non-string entry
  // would make globMatch throw mid-match. Reject it here so it fails CLOSED.
  if (declaredRails.some((rail) => typeof rail !== 'string' || rail.length === 0)) {
    return { state: 'deny', reason: `active ticket ${against.value.id} has a malformed rail entry — failing closed` };
  }
  return { state: 'active', rails: [...declaredRails, ...TRUST_ROOT_RAILS], activeId: against.value.id };
}

/**
 * Decide whether a structured edit/write to a specific path should be allowed or
 * denied. Pure and fail-safe: returns { decision: 'allow' | 'deny', reason }.
 * Preconditions are delegated to railPreconditions (single source of truth).
 */
export function checkRail({ filePath, tool, root = process.cwd(), env = process.env }) {
  if (classifyTool(tool) === 'readonly') {
    return { decision: 'allow', reason: `tool "${tool}" is read-only` };
  }
  const pre = railPreconditions({ root, env });
  if (pre.state === 'inactive') return { decision: 'allow', reason: pre.reason };
  if (pre.state === 'deny') return { decision: 'deny', reason: pre.reason };

  // Enforcing: match BOTH the lexical path and the symlink-resolved real path (so a
  // symlink alias whose target is a frozen rail can't slip past a name check).
  const candidates = new Set([canonicalizePath(filePath, root), resolveRailPath(filePath, root)]);
  for (const path of candidates) {
    const hit = pre.rails.find((rail) => rail === path || globMatch(rail, path));
    if (hit) {
      return { decision: 'deny', reason: `frozen rail "${hit}" (active ticket ${pre.activeId})` };
    }
  }
  return { decision: 'allow', reason: 'path is not a frozen rail' };
}
