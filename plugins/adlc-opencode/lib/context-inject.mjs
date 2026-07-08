// context-inject.mjs — active-ticket context surfaced to the model (Phase 3).
//
// Context-rot defense (pi F1/F3 parity): the frozen rails, scope, and active
// ticket id are re-stated to the model every turn via the system prompt
// (experimental.chat.system.transform), named in the edit/write tool
// descriptions (tool.definition), and shown as a session-start statusline toast
// — so the model is reminded of the constraints it must not violate BEFORE it
// tries, not only denied after.
//
// Pure and fail-safe: reads .adlc/ but never throws; returns null when there is
// nothing to inject (not initialized, enforcement off, or no active ticket).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTickets } from '@adlc/core';
import { resolveRailsInForce, resolveActiveTicketId } from '../rails-checker.mjs';

// Ticket fields (id, rails, scope) are repo data but are NOT trusted as prompt
// content: a hostile or careless ticket could smuggle newlines or instructions
// that, injected raw into the system prompt every turn, would steer the model
// ("ignore previous instructions…"). Sanitize before injection — replace control
// characters with spaces, collapse whitespace, length-cap. A glob/path/id can't
// legitimately contain newlines, so this never distorts a real value.
const MAX_FIELD = 200;
const MAX_LIST = 40;

export function sanitizeField(value) {
  const s = String(value ?? '');
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    // Control characters (U+0000–U+001F incl. newline/CR/tab, and U+007F) → space.
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
}

export function sanitizeList(values) {
  return (Array.isArray(values) ? values : [])
    .map(sanitizeField)
    .filter((v) => v !== '')
    .slice(0, MAX_LIST);
}

/**
 * Resolve the active ticket's model-facing context (sanitized).
 * @returns {{ ticketId: string, rails: string[], scope: string[] } | null}
 */
export function resolveTicketContext(root, env = process.env) {
  try {
    const force = resolveRailsInForce(root, env);
    if (!force.active || force.conflict || !force.ticketId) return null;
    const active = resolveActiveTicketId(root, env);
    let scope = [];
    const ticketsPath = join(root, '.adlc', 'tickets.json');
    if (existsSync(ticketsPath)) {
      const { tickets } = loadTickets(ticketsPath);
      const ticket = tickets.find((t) => t.id === active.id);
      scope = Array.isArray(ticket?.scope) ? ticket.scope : [];
    }
    return {
      ticketId: sanitizeField(force.ticketId),
      rails: sanitizeList(force.rails),
      scope: sanitizeList(scope),
    };
  } catch {
    return null;
  }
}

/**
 * The system-prompt block appended each turn. Returns null when there's nothing
 * to say (so the transform is a no-op outside an enforced ADLC build). The
 * sanitized ticket data is rendered under an explicit "constraints" header, not
 * interleaved as free prose, so it reads as data.
 */
export function buildSystemContext(root, env = process.env) {
  const ctx = resolveTicketContext(root, env);
  if (!ctx) return null;
  const lines = [
    '# ADLC — active build constraints (P4 enforcement is ON)',
    `Active ticket: ${ctx.ticketId}.`,
    ctx.rails.length
      ? `FROZEN RAILS (do NOT edit — writes are blocked and reverted): ${ctx.rails.join(', ')}.`
      : 'No declared rails; the ticket store and active-ticket pointer are frozen.',
  ];
  if (ctx.scope.length) {
    lines.push(`In scope for this ticket: ${ctx.scope.join(', ')}. Edits outside scope are flagged.`);
  }
  lines.push('Make behavior changes visible; do not add unapproved test-skip or lint/type-ignore suppressions.');
  return lines.join('\n');
}

/**
 * The clause appended to an edit/write tool description so the model sees the
 * frozen rails at the point of choosing to write. Returns null when inert.
 */
export function buildToolRailNotice(root, env = process.env) {
  const ctx = resolveTicketContext(root, env);
  if (!ctx || ctx.rails.length === 0) return null;
  return ` NOTE (ADLC ticket ${ctx.ticketId}): these paths are FROZEN RAILS and writes to them are blocked — ${ctx.rails.join(', ')}.`;
}

/**
 * A short session-start statusline, surfaced as an info toast via the confirmed
 * client.tui.showToast channel (the verifiable native touch — the persistent
 * JSX statusline slot is deferred, see docs). Returns null when inert.
 */
export function buildStatusLine(root, env = process.env) {
  const ctx = resolveTicketContext(root, env);
  if (!ctx) return null;
  const n = ctx.rails.length;
  return `ADLC ${ctx.ticketId} · P4 enforcing · ${n} rail${n === 1 ? '' : 's'} frozen`;
}
