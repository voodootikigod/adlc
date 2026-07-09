// rails-checker.mjs — the ADLC rail-enforcement decision for pi.
//
// THIN adapter: every rail/glob/ticket/shell primitive is delegated to
// @adlc/core (the single source of truth, per ADR 0004). The only non-core
// logic here is mapping pi's extension events onto that core and the
// sibling-hook enforcement contract (active-ticket resolution, trust-root
// freeze) that adlc-codex and adlc-opencode implement. Unlike the siblings,
// pi's enforcement switch is the active ticket itself (no ADLC_P4_ENFORCEMENT)
// — documented in docs/integrations/pi.md.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadTickets, globMatch, inScope, classifyShellCommand, resolveRailPath } from '@adlc/core';

// The ticket file and the active-ticket pointer are the rail trust root: frozen
// whenever a ticket is active, even if the ticket declares no rails, so the
// rail set cannot be quietly edited away.
export const TRUST_ROOT_RAILS = ['.adlc/tickets.json', '.adlc/current-ticket.json'];

// Directories the framework itself writes evidence into; always in scope
// (except the trust roots, which are never writable by the agent).
const FRAMEWORK_DIRS = ['.adlc/', '.omo/'];

// Suppression markers the reactive gate scans added lines for. The strings
// are assembled by concatenation so this source file never carries an
// operative-looking marker literal — the ADLC text-scanning gates (rails-guard
// suppression scan included) must stay quiet on diffs of the gate itself.
const m = (a, b) => a + b;
export const SUPPRESSION_MARKERS = [
  m('@ts-', 'ignore'),
  m('@ts-', 'expect-error'),
  m('eslint-', 'disable'),
  m('eslint-', 'disable-next-line'),
  m('.sk', 'ip('),
  m('.on', 'ly('),
  m('xf', 'ail'),
  m('# no', 'qa'),
  m('#[ig', 'nore]'),
];

/** Canonicalize a path to a forward-slash path relative to the repo root (lexical). */
export function canonicalizePath(filePath, root) {
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  return relative(root, abs).split('\\').join('/');
}

/**
 * Resolve the active ticket for a repo root. The switch is the ticket itself:
 * ADLC_TICKET env or .adlc/current-ticket.json. Sibling-contract semantics:
 * if both are set and disagree, that is a tamper signal — fail closed.
 * Returns { ticketId, ticket, error }:
 *   ticketId null            → no enforcement (inert)
 *   ticketId + ticket        → enforce with this ticket
 *   ticketId + error string  → enforcement requested but broken → fail closed
 */
export function resolveActiveTicket(root, env = process.env) {
  const envId = (env.ADLC_TICKET ?? '').trim() || null;
  let fileId = null;
  let fileError = null;
  const currentPath = join(root, '.adlc', 'current-ticket.json');
  if (existsSync(currentPath)) {
    try {
      const data = JSON.parse(readFileSync(currentPath, 'utf8'));
      const raw = typeof data === 'string' ? data : data.id ?? data.ticket ?? data.ticketId;
      fileId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    } catch (err) {
      fileError = `unreadable .adlc/current-ticket.json: ${err.message}`;
    }
  }

  if (envId && fileId && envId !== fileId) {
    return {
      ticketId: envId,
      ticket: null,
      error: `ADLC_TICKET ("${envId}") and .adlc/current-ticket.json ("${fileId}") disagree — tamper signal, failing closed`,
    };
  }
  const ticketId = envId ?? fileId;
  if (!ticketId) {
    // An unreadable pointer with no env override is still a tamper signal.
    if (fileError) return { ticketId: '(unknown)', ticket: null, error: fileError };
    return { ticketId: null, ticket: null, error: null };
  }

  const ticketsPath = env.ADLC_TICKETS ?? join(root, '.adlc', 'tickets.json');
  const { tickets, errors } = loadTickets(ticketsPath);
  if (errors.length > 0) {
    return { ticketId, ticket: null, error: `ticket database failed to load: ${errors[0]}` };
  }
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    return { ticketId, ticket: null, error: `active ticket "${ticketId}" not found in ${ticketsPath}` };
  }
  return { ticketId, ticket, error: null };
}

/**
 * Does a target path hit the frozen rail set (trust roots + the active
 * ticket's rails)? Checks both the lexical path and the symlink-resolved path
 * so an alias can't slip past. Returns the matched rail (string) or null.
 */
export function railHit(filePath, ticket, root) {
  const candidates = new Set([canonicalizePath(filePath, root), resolveRailPath(filePath, root)]);
  for (const candidate of candidates) {
    if (TRUST_ROOT_RAILS.includes(candidate)) return candidate;
    for (const rail of ticket?.rails ?? []) {
      if (globMatch(rail, candidate)) return rail;
    }
  }
  return null;
}

/** Is a path within the ticket's declared scope? Empty scope = unrestricted. */
export function pathInScope(filePath, ticket, root) {
  const canonical = canonicalizePath(filePath, root);
  // The trust roots are NEVER in scope for agent modification.
  if (TRUST_ROOT_RAILS.includes(canonical)) return false;
  if (!ticket?.scope || ticket.scope.length === 0) return true;
  // Framework evidence dirs stay writable under any scope.
  if (FRAMEWORK_DIRS.some((dir) => canonical.startsWith(dir))) return true;
  return inScope(ticket, canonical);
}

/**
 * Decision for a structured file mutation (pi `write`/`edit` — input.path per
 * the pinned v0.80.3 tool schemas). Rails first (symlink-aware), then scope.
 */
export function checkStructuredWrite(filePath, ticket, root) {
  const hit = railHit(filePath, ticket, root);
  if (hit) {
    return { decision: 'deny', reason: `"${filePath}" matches frozen rail "${hit}"` };
  }
  if (!pathInScope(filePath, ticket, root)) {
    return { decision: 'deny', reason: `"${filePath}" is out of the ticket's declared scope` };
  }
  return { decision: 'allow', reason: 'target is neither a frozen rail nor out of scope' };
}

/**
 * Pure branch creation cannot touch a rail: `git checkout -b <name>` /
 * `git switch -c <name>` with nothing else on the line. The character class
 * excludes separators (;&|) and whitespace, so nothing can be smuggled after
 * the branch name. Everything else falls through to the codex ladder (where
 * bare `git checkout` is opaque and denied).
 */
export function isSafeBranchCreation(command) {
  return /^\s*git\s+(?:checkout\s+-b|switch\s+-c)\s+[A-Za-z0-9._/-]+\s*$/.test(String(command ?? ''));
}

/**
 * Decision for a shell command — the codex-parity enforcement ladder over
 * @adlc/core's classifier. Shell paths are checked against RAILS only (scope
 * enforcement is a structured-edit concern; the reactive diff gate and the CI
 * rails-guard remain the backstop for anything the classifier cannot see):
 *   safe branch creation                    → allow
 *   positively read-only                    → allow (unless output-option smuggle)
 *   neither read-only nor visibly mutating  → deny (unverifiable → fail closed)
 *   opaque mutation (git checkout/apply/…)  → deny
 *   changes cwd / uses expansion            → deny (targets unverifiable)
 *   mutation with no literal targets        → deny (fail closed)
 *   literal targets                         → deny only on a frozen-rail hit
 */
export function checkShellCommand(command, ticket, root) {
  if (isSafeBranchCreation(command)) {
    return { decision: 'allow', mutating: false, reason: 'pure branch creation cannot touch a rail' };
  }
  const c = classifyShellCommand(command);
  if (c.readOnly) {
    if (c.writeOption) {
      return { decision: 'deny', reason: 'read-only shell command uses an output option; use a structured edit tool or a literal path-transparent mutation' };
    }
    return { decision: 'allow', mutating: false, reason: 'shell command is positively read-only' };
  }
  if (!c.mutating) {
    return { decision: 'deny', reason: 'shell command is neither positively read-only nor a path-transparent mutation — unverifiable while a ticket is active (the CI diff gate remains the backstop)' };
  }
  if (c.opaque) {
    return { decision: 'deny', reason: 'mutating shell command uses an opaque form (git apply/checkout/patch/tar…); use a structured edit tool or a literal path-transparent mutation' };
  }
  if (c.changesCwd) {
    return { decision: 'deny', reason: 'mutating shell command changes cwd; target paths cannot be verified against the frozen rails' };
  }
  if (c.expands) {
    return { decision: 'deny', reason: 'mutating shell command uses shell expansion ($VAR, $(…), backticks, globs); target paths cannot be verified against the frozen rails' };
  }
  if (c.paths.length === 0) {
    return { decision: 'deny', reason: 'mutating shell command carries no literal target paths — failing closed while a ticket is active' };
  }
  for (const target of c.paths) {
    const hit = railHit(target, ticket, root);
    if (hit) {
      return { decision: 'deny', reason: `shell mutation targets frozen rail "${hit}"` };
    }
  }
  return { decision: 'allow', mutating: true, reason: 'shell mutation targets no frozen rail' };
}

/** Suppressions allowed by the ticket: structured field + `allow-suppression:` body lines. */
export function getAllowedSuppressions(ticket) {
  const allowed = new Set(ticket?.allowedSuppressions ?? []);
  for (const line of (ticket?.body ?? '').split(/\r?\n/)) {
    const match = line.match(/^allow-suppression:\s*(\S+)/);
    if (match) allowed.add(match[1]);
  }
  return Array.from(allowed);
}
