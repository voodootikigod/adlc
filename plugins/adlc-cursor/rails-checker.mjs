// rails-checker.mjs — the ADLC rail-enforcement decision for Cursor.
//
// This is a THIN adapter: every rail/glob/ticket primitive is delegated to
// @adlc/core (the single source of truth, per ADR 0006 / ADR 0004). It must NOT
// re-implement glob or ticket loading. The only non-core logic here is the
// sibling-hook enforcement contract (active-ticket resolution, phase gating,
// trust-root freeze) that adlc-opencode and adlc-codex already implement, plus a
// Cursor-specific tool classifier. The Cursor wire-format mapping (preToolUse
// stdin/stdout) lives in hooks/adlc-rails-guard.mjs; this file is editor-agnostic.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { loadTickets, globMatch } from '@adlc/core';

// The ticket file and the active-ticket pointer are the rail trust root: they are
// frozen whenever enforcement is active, even if no ticket declares them, so the
// rail set cannot be quietly edited away. Mirrors adlc-opencode/rails-checker.mjs.
export const TRUST_ROOT_RAILS = ['.adlc/tickets.json', '.adlc/current-ticket.json'];

// Cursor's structured file-mutation tools (normalized to lowercase, non-alpha
// stripped). Cursor exposes Write/Edit/MultiEdit/search_replace/delete_file-style
// tools to the agent. We classify a tool as MUTATING if its normalized name
// contains any of these substrings — note "replace" so search_replace/str_replace
// classify as mutating even though they also contain the read word "search".
// Shell writes are intentionally NOT gated in-session (Turing-complete shell);
// they fall to the CI diff gate.
export const MUTATING_TOOL_HINTS = ['write', 'edit', 'replace', 'patch', 'create', 'delete', 'remove', 'rename', 'move', 'apply', 'insert', 'append'];

// The Cursor preToolUse `matcher` regex, DERIVED from MUTATING_TOOL_HINTS so the
// hook-routing pre-filter can never drift from the classifier. If a mutation tool
// name shares no hint with this set it would bypass the in-session hook entirely
// (the matcher decides what reaches the guard) — but it would also classify as
// 'other' and, on the paths that do reach the guard, fail closed. Anything the
// matcher misses still falls to the unbypassable CI rail-freeze gate. Used by both
// the committed hooks.json template and the scaffolder (single source of truth).
export const MUTATING_MATCHER = `(?i)(${MUTATING_TOOL_HINTS.join('|')})`;

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
    resolved = join(realpathOr(dirname(abs)), basename(abs));
  }
  return relative(realpathOr(root), resolved).split('\\').join('/');
}

/**
 * Resolve the active ticket id from process.env.ADLC_TICKET OR
 * .adlc/current-ticket.json. If both are set and disagree, that is a tamper
 * signal — return { conflict: true } so the caller fails closed.
 */
export function resolveActiveTicketId(root, env) {
  const envTicket = (env.ADLC_TICKET ?? '').trim() || null;
  let fileTicket = null;
  const currentPath = join(root, '.adlc', 'current-ticket.json');
  if (existsSync(currentPath)) {
    try {
      const data = JSON.parse(readFileSync(currentPath, 'utf8'));
      const raw = typeof data === 'string' ? data : data.id ?? data.ticket;
      fileTicket = (raw ?? '').toString().trim() || null;
    } catch {
      // An unparseable pointer is itself a tamper signal: fail closed.
      return { id: null, conflict: true };
    }
  }
  if (envTicket && fileTicket && envTicket !== fileTicket) {
    return { id: null, conflict: true };
  }
  return { id: envTicket ?? fileTicket, conflict: false };
}

/**
 * Decide whether a structured edit/write should be allowed or denied.
 * Pure and fail-safe: returns { decision: 'allow' | 'deny', reason }.
 *
 * Enforcement contract (identical to the sibling hooks):
 *  - only structured mutating tools are gated; read-only tools always allow;
 *  - enforcement is phase-scoped to ADLC_P4_ENFORCEMENT === '1';
 *  - no-op when the repo is not ADLC-initialized;
 *  - the active ticket is the SINGLE source of declared rails; a conflicting
 *    active-ticket signal fails closed;
 *  - rails in force = active ticket's declared rails PLUS the trust-root rails.
 */
export function checkRail({ filePath, tool, root = process.cwd(), env = process.env }) {
  if (classifyTool(tool) === 'readonly') {
    return { decision: 'allow', reason: `tool "${tool}" is read-only` };
  }
  // Mutating and unrecognized structured tools that carry a path are checked
  // (fail closed): a new mutation tool name can't slip an edit past the guard.
  if (env.ADLC_P4_ENFORCEMENT !== '1') {
    return { decision: 'allow', reason: 'enforcement inactive (ADLC_P4_ENFORCEMENT !== "1")' };
  }
  const ticketsPath = join(root, '.adlc', 'tickets.json');
  if (!existsSync(ticketsPath)) {
    return { decision: 'allow', reason: 'repo not ADLC-initialized (no .adlc/tickets.json)' };
  }

  const active = resolveActiveTicketId(root, env);
  if (active.conflict) {
    return { decision: 'deny', reason: 'conflicting active-ticket signal (ADLC_TICKET vs .adlc/current-ticket.json)' };
  }
  if (!active.id) {
    return { decision: 'allow', reason: 'no active ticket resolved' };
  }

  const { tickets, errors } = loadTickets(ticketsPath);
  // A corrupt/invalid tickets.json makes @adlc/core return an empty ticket list
  // plus errors (it does NOT throw). Honoring that is load-bearing: ignoring it
  // would silently drop the active ticket's declared rails to just the trust
  // roots — i.e. fail OPEN for declared rails exactly when the rail trust root is
  // corrupt. Under active enforcement with an active ticket, fail CLOSED instead.
  if (errors && errors.length) {
    return { decision: 'deny', reason: `tickets.json failed to load/validate (${errors.length} error(s)) — failing closed` };
  }
  const ticket = tickets.find((t) => t.id === active.id);
  const declaredRails = ticket?.rails ?? [];
  const rails = [...declaredRails, ...TRUST_ROOT_RAILS];

  // Match BOTH the lexical path and the symlink-resolved real path (so a symlink
  // alias whose target is a frozen rail can't slip past a name check).
  const candidates = new Set([canonicalizePath(filePath, root), resolveRailPath(filePath, root)]);
  for (const path of candidates) {
    const hit = rails.find((rail) => rail === path || globMatch(rail, path));
    if (hit) {
      return { decision: 'deny', reason: `frozen rail "${hit}" (active ticket ${active.id})` };
    }
  }
  return { decision: 'allow', reason: 'path is not a frozen rail' };
}
