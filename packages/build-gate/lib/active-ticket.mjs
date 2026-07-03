// active-ticket.mjs — resolve which ticket is "in flight" for the current
// build (issue #48, tie-in). Reuses the SAME env var / pointer-file
// convention every other ADLC harness integration already implements:
//   - plugins/adlc-codex/hooks/adlc-rails-guard.mjs resolveActiveTicketId()
//   - plugins/adlc-antigravity/rails-checker.mjs resolveActiveTicketId()
//   - plugins/adlc-opencode/rails-checker.mjs (same contract)
// The active ticket is process.env.ADLC_TICKET OR .adlc/current-ticket.json.
// If both are set and disagree, that is a TAMPER SIGNAL, not an ambiguity to
// silently resolve — callers must fail closed (conflict: true).
//
// This module is the reusable Path-A form of that logic (importable by any
// harness/CI wrapper with normal npm resolution). Claude Code's own
// PreToolUse hook cannot resolve @adlc/* packages at runtime (it only shells
// out to the globally-installed `adlc` binary — see adlc-hook.mjs's
// globMatch comment), so plugins/adlc-claude-code/hooks/adlc-hook.mjs ports
// an equivalent copy of resolveActiveTicketId() verbatim, marked "KEEP IN
// SYNC with @adlc/build-gate".

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {object} [opts]
 * @param {string} [opts.dir] - project root to look for .adlc/current-ticket.json in (default '.')
 * @param {NodeJS.ProcessEnv} [opts.env] - env to read ADLC_TICKET from (default process.env)
 * @returns {{ id: string|null, conflict: boolean }}
 */
export function resolveActiveTicketId({ dir = '.', env = process.env } = {}) {
  const envTicket = (env.ADLC_TICKET ?? '').trim() || null;
  let fileTicket = null;

  const currentPath = join(dir, '.adlc', 'current-ticket.json');
  if (existsSync(currentPath)) {
    try {
      const data = JSON.parse(readFileSync(currentPath, 'utf8'));
      const raw = typeof data === 'string' ? data : (data?.id ?? data?.ticket);
      fileTicket = (raw ?? '').toString().trim() || null;
    } catch {
      // An unparseable pointer file is itself a tamper signal — fail closed
      // rather than silently treating it as "no active ticket".
      return { id: null, conflict: true };
    }
  }

  if (envTicket && fileTicket && envTicket !== fileTicket) {
    return { id: null, conflict: true };
  }

  return { id: envTicket ?? fileTicket, conflict: false };
}
