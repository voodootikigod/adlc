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

// OpenCode's structured file-mutation tools. Bash-style writes are intentionally
// NOT gated in-session (Turing-complete shell); they fall to the CI diff gate.
export const MUTATING_TOOLS = ['edit', 'write'];

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
 * Decide whether a structured edit/write should be allowed or denied.
 * Pure and fail-safe: returns { decision: 'allow' | 'deny', reason }.
 *
 * Enforcement contract (identical to the sibling hooks):
 *  - only the structured mutating tools are gated;
 *  - enforcement is phase-scoped to ADLC_P4_ENFORCEMENT === '1';
 *  - no-op when the repo is not ADLC-initialized;
 *  - the active ticket is the SINGLE source of declared rails; a conflicting
 *    active-ticket signal fails closed;
 *  - rails in force = active ticket's declared rails PLUS the trust-root rails.
 */
export function checkRail({ filePath, tool, root = process.cwd(), env = process.env }) {
  if (!MUTATING_TOOLS.includes(tool)) {
    return { decision: 'allow', reason: `tool "${tool}" is not a structured mutating tool` };
  }
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

  const { tickets } = loadTickets(ticketsPath);
  const ticket = tickets.find((t) => t.id === active.id);
  const declaredRails = ticket?.rails ?? [];
  const rails = [...declaredRails, ...TRUST_ROOT_RAILS];

  // Match BOTH the lexical path (normal case) and the symlink-resolved real path
  // (so a symlink alias whose target is a frozen rail can't slip past a name check).
  const candidates = new Set([canonicalizePath(filePath, root), resolveRailPath(filePath, root)]);
  for (const path of candidates) {
    const hit = rails.find((rail) => rail === path || globMatch(rail, path));
    if (hit) {
      return { decision: 'deny', reason: `frozen rail "${hit}" (active ticket ${active.id})` };
    }
  }
  return { decision: 'allow', reason: 'path is not a frozen rail' };
}

/**
 * Probe whether the host OpenCode SDK can actually ENFORCE a denial (abort the
 * tool via a thrown error / onFailure:deny). Per integration-plan Phase D, the
 * in-session hook must not be treated as enforcing unless this is true; otherwise
 * it is advisory and preflight should fail closed unless advisory hooks are
 * explicitly allowed. We cannot introspect the SDK contract portably, so we treat
 * an explicit capability flag as the signal and default to "unknown".
 */
export function probeEnforcementCapability(api, env = process.env) {
  if (env.ADLC_OPENCODE_ENFORCES === '1') return true;
  if (env.ADLC_OPENCODE_ENFORCES === '0') return false;
  // The SDK may advertise the capability; absent that, enforcement is unproven.
  return Boolean(api?.capabilities?.toolExecuteBeforeDeny);
}
