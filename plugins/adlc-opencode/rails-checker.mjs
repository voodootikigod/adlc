// rails-checker.mjs — the ADLC rail-enforcement decision for OpenCode.
//
// This is a THIN adapter: every rail/glob/ticket primitive is delegated to
// @adlc/core (the single source of truth, per ADR 0004 / integration-plan §6.6).
// It must NOT re-implement glob or ticket loading. The only non-core logic here
// is mapping OpenCode's hook arguments onto that core and the sibling-hook
// enforcement contract (active-ticket resolution, phase gating, trust-root
// freeze) that adlc-codex and adlc-pi already implement.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { loadTickets, globMatch } from '@adlc/core';

// The ticket file and the active-ticket pointer are the rail trust root: they are
// frozen whenever enforcement is active, even if no ticket declares them, so the
// rail set cannot be quietly edited away. Mirrors adlc-codex/hooks/adlc-rails-guard.mjs.
export const TRUST_ROOT_RAILS = ['.adlc/tickets.json', '.adlc/current-ticket.json'];

// OpenCode's known structured file-mutation tools. Bash-style writes are
// intentionally NOT gated in-session (Turing-complete shell); they fall to the CI
// diff gate.
export const MUTATING_TOOLS = ['edit', 'write', 'patch', 'multiedit', 'apply_patch'];

// Known read-only tools that may carry a file path but never mutate it. The gate
// fails CLOSED: only these are skipped; any other structured tool that reaches the
// checker — including unrecognized mutation tools — is checked against the rail
// set rather than silently allowed.
export const READONLY_TOOLS = ['read', 'grep', 'glob', 'list', 'ls', 'webfetch', 'websearch', 'codebase_search', 'lsp', 'todoread'];

// First-party tools with no single-file mutation semantics, deliberately not
// gated in-session (bash falls to the CI diff gate; the rest don't write files).
// Anything NOT in this list or READONLY_TOOLS is treated as potentially mutating.
export const UNGATED_TOOLS = ['bash', 'task', 'skill', 'todowrite', 'question'];

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
 * set, so a symlink whose real target is a frozen rail (e.g. an alias pointing at
 * .adlc/tickets.json) cannot slip a write past a lexical name check. Falls back to
 * the lexical path for anything that can't be resolved.
 */
export function resolveRailPath(filePath, root) {
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  // The file may not exist yet (a `write` creating it): resolve the deepest
  // existing ancestor (catches a symlinked parent dir), then re-append the tail.
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
 * Resolve whether rails are currently IN FORCE and, if so, the effective rail
 * set. Shared by the single-path check and the whole-tool-call check so the
 * gating ladder (phase flag → initialized → active ticket → rails) exists once.
 * Returns one of:
 *   { active: false, reason }                          — nothing to enforce
 *   { active: true, conflict: true, reason }           — tamper signal, fail closed
 *   { active: true, conflict: false, ticketId, rails } — rails in force
 */
export function resolveRailsInForce(root, env) {
  if (env.ADLC_P4_ENFORCEMENT !== '1') {
    return { active: false, reason: 'enforcement inactive (ADLC_P4_ENFORCEMENT !== "1")' };
  }
  const ticketsPath = join(root, '.adlc', 'tickets.json');
  if (!existsSync(ticketsPath)) {
    return { active: false, reason: 'repo not ADLC-initialized (no .adlc/tickets.json)' };
  }
  const active = resolveActiveTicketId(root, env);
  if (active.conflict) {
    return { active: true, conflict: true, reason: 'conflicting active-ticket signal (ADLC_TICKET vs .adlc/current-ticket.json)' };
  }
  if (!active.id) {
    return { active: false, reason: 'no active ticket resolved' };
  }
  const { tickets } = loadTickets(ticketsPath);
  const ticket = tickets.find((t) => t.id === active.id);
  return { active: true, conflict: false, ticketId: active.id, rails: [...(ticket?.rails ?? []), ...TRUST_ROOT_RAILS] };
}

/**
 * Extract every candidate target path from a tool call's args. Tolerant across
 * the arg shapes the structured mutators use: a single `filePath`/`path`/`file`
 * string, a `files` array (strings or objects), or an `edits` array of objects.
 * Returns [] when nothing path-like is found — the caller decides whether that
 * fails closed (mutating/unknown tool while rails are in force) or is benign.
 */
export function extractTargets(args) {
  if (!args || typeof args !== 'object') return [];
  const targets = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) targets.push(v); };
  push(args.filePath); push(args.path); push(args.file);
  for (const list of [args.files, args.edits]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === 'string') push(entry);
      else if (entry && typeof entry === 'object') { push(entry.filePath); push(entry.path); push(entry.file); }
    }
  }
  return targets;
}

function railHit(target, rails, root) {
  // Match BOTH the lexical path (normal case) and the symlink-resolved real path
  // (so a symlink alias whose target is a frozen rail can't slip past a name check).
  const candidates = new Set([canonicalizePath(target, root), resolveRailPath(target, root)]);
  for (const path of candidates) {
    const hit = rails.find((rail) => rail === path || globMatch(rail, path));
    if (hit) return hit;
  }
  return null;
}

/**
 * Decide whether a whole tool call should be allowed or denied. This is the
 * hook-facing entry point. Pure and fail-safe: returns
 * { decision: 'allow' | 'deny', reason }.
 *
 * Enforcement contract (identical to the sibling hooks):
 *  - tool names are normalized (lowercased) before classification;
 *  - known read-only tools and the deliberately-ungated first-party tools
 *    (bash et al — CI diff gate covers them) are allowed;
 *  - enforcement is phase-scoped to ADLC_P4_ENFORCEMENT === '1';
 *  - no-op when the repo is not ADLC-initialized or no active ticket resolves;
 *  - a conflicting active-ticket signal fails closed;
 *  - rails in force = active ticket's declared rails PLUS the trust-root rails;
 *  - EVERY extractable target path is checked; a mutating or UNKNOWN tool whose
 *    target cannot be extracted is DENIED while rails are in force (fail closed —
 *    an unrecognized third-party write tool must not slip past on arg shape).
 */
export function checkToolCall({ tool, args, root = process.cwd(), env = process.env }) {
  const name = String(tool ?? '').toLowerCase();
  if (READONLY_TOOLS.includes(name)) {
    // Reading a rail is legitimate; allow by name. Residual risk: a hostile
    // co-installed plugin could register a WRITING tool under a read-only name —
    // that class is closed by the tool-name-independent file.edited backstop
    // (opencode-native-flush plan Phase 2.5) and, at commit time, the CI gate.
    return { decision: 'allow', reason: `tool "${name}" is read-only` };
  }
  // Operators can extend the ungated list for benign third-party tools that a
  // railed build legitimately needs (e.g. ADLC_UNGATED_TOOLS="symbols_index").
  // An explicit opt-out per tool keeps the DEFAULT fail-closed for unknown
  // tools (an unrecognized write tool must not slip past on arg shape) without
  // hard-blocking benign no-target tools forever. Extended entries get the same
  // spoof guard as the built-in ungated list.
  const ungated = UNGATED_TOOLS.concat(
    String(env.ADLC_UNGATED_TOOLS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  if (ungated.includes(name)) {
    // Not gated by design (bash et al fall to the CI diff gate) — BUT a benign
    // ungated tool never carries a file-path arg, so if this call DOES carry an
    // extractable target that resolves to a frozen rail, treat the name as
    // spoofed/abused and deny rather than allow purely by name.
    const force = resolveRailsInForce(root, env);
    if (force.active && !force.conflict) {
      for (const target of extractTargets(args)) {
        const hit = railHit(target, force.rails, root);
        if (hit) {
          return { decision: 'deny', reason: `ungated tool "${name}" carries a frozen-rail target — frozen rail "${hit}" (active ticket ${force.ticketId})` };
        }
      }
    }
    return { decision: 'allow', reason: `tool "${name}" is not gated in-session (CI diff gate covers it)` };
  }
  const force = resolveRailsInForce(root, env);
  if (!force.active) return { decision: 'allow', reason: force.reason };
  if (force.conflict) return { decision: 'deny', reason: force.reason };

  const targets = extractTargets(args);
  if (targets.length === 0) {
    return {
      decision: 'deny',
      reason: `mutating/unknown tool "${name}" carries no extractable target path — failing closed while rails are in force (active ticket ${force.ticketId})`,
    };
  }
  for (const target of targets) {
    const hit = railHit(target, force.rails, root);
    if (hit) {
      return { decision: 'deny', reason: `frozen rail "${hit}" (active ticket ${force.ticketId})` };
    }
  }
  return { decision: 'allow', reason: 'no target is a frozen rail' };
}

/**
 * Single-path convenience used by tests and sibling callers: the same contract
 * as checkToolCall for a tool call whose one target is `filePath`.
 */
export function checkRail({ filePath, tool, root = process.cwd(), env = process.env }) {
  return checkToolCall({ tool, args: { filePath }, root, env });
}
