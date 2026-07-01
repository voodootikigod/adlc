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
  if (!existsSync(path)) return { tickets: [], errors: [`tickets file not found: ${path}`] };
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { tickets: [], errors: [`invalid JSON in ${path}: ${err.message}`] };
  }
  const tickets = data.tickets ?? [];
  const errors = [];
  const seen = new Set();
  for (const t of tickets) {
    errors.push(...validateTicket(t));
    if (t.id) {
      if (seen.has(t.id)) errors.push(`duplicate ticket id: ${t.id}`);
      seen.add(t.id);
    }
  }
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      if (e.to && !seen.has(e.to)) errors.push(`${t.id}: edge to unknown ticket ${e.to}`);
    }
  }
  return { tickets, errors };
}

export function globMatch(pattern, path) {
  const regex = new RegExp(
    '^' +
      pattern
        .split(/(\*\*\/|\*\*|\*)/)
        .map((part) => {
          if (part === '**/') return '(?:.*/)?';
          if (part === '**') return '.*';
          if (part === '*') return '[^/]*';
          return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('') +
      '$'
  );
  return regex.test(path);
}
