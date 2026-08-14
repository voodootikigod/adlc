// core-inline.mjs — self-contained port of the @adlc/core primitives the
// rails-checker needs (loadTickets → {tickets, errors}, globMatch) + their
// validateTicket helper. Imports ONLY node: builtins.
//
// WHY: `agy plugin install` COPIES this plugin into ~/.gemini/config/plugins/<name>/
// WITHOUT node_modules, so a runtime `import '@adlc/core'` fails to resolve and the
// hook fails closed on every tool (caught by the Task-10 live e2e gate). Like
// adlc-codex's self-contained hook, we inline these primitives. Ported verbatim
// from packages/core/lib/tickets.mjs — keep in sync if core's contract changes.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { loadTicketStoreReadOnly, ticketStoreExists } from './generated-ticket-reader.mjs';
export { ticketStoreExists };

export const TICKETS_PATH = '.adlc/tickets.json';

export function validateTicket(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['ticket is not an object'];
  if (!t.id || typeof t.id !== 'string') errors.push('missing string id');
  if (!t.title || typeof t.title !== 'string') errors.push(`${t.id ?? '?'}: missing string title`);
  if (t.scope !== undefined && !Array.isArray(t.scope)) errors.push(`${t.id}: scope must be an array of globs`);
  if (t.rails !== undefined && !Array.isArray(t.rails)) errors.push(`${t.id}: rails must be an array of paths`);
  if (t.edges !== undefined) {
    if (!Array.isArray(t.edges)) errors.push(`${t.id}: edges must be an array`);
    else for (const e of t.edges) {
      if (!e || typeof e.to !== 'string') errors.push(`${t.id}: edge missing string "to"`);
    }
  }
  if (t.duration !== undefined && (typeof t.duration !== 'number' || t.duration <= 0)) {
    errors.push(`${t.id}: duration must be a positive number`);
  }
  return errors;
}

export function loadTickets(path = TICKETS_PATH) {
  try {
    const conventional = path === TICKETS_PATH || path.replaceAll('\\', '/').endsWith('/.adlc/tickets.json');
    const root = path === TICKETS_PATH ? process.cwd() : conventional && isAbsolute(path) ? dirname(dirname(path)) : process.cwd();
    const env = conventional ? process.env : { ...process.env, ADLC_TICKET_STORE: path, ADLC_TICKETS: undefined };
    const snapshot = loadTicketStoreReadOnly({ root, env });
    return { tickets: snapshot.tickets.map((ticket) => structuredClone(ticket)), errors: [] };
  } catch (err) {
    return { tickets: [], errors: [err.message] };
  }
}

// The rail/scope glob matcher is a GENERATED verbatim copy of
// packages/core/lib/glob.mjs: this file is installed without node_modules, so it
// cannot import @adlc/core, and a hand-kept copy is what drifted before.
import { globMatch } from './generated-glob-match.mjs';

export { globMatch };
