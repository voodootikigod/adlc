// Plain-file readers for a repo's `.adlc/` state (plan §5.1). Fail soft on
// absence, fail closed (explicit 'unreadable') on malformed data — never
// throw into the daemon. Structured ticket data beyond these files comes from
// the trusted `adlc` CLI, never from workspace imports (the installed plugin
// is a bare clone with no node_modules).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Read `.adlc/current-ticket.json`. → {state:'absent'|'unreadable'} or
 *  {state:'active', id}. */
export function readActiveTicket(repoRoot) {
  const path = join(repoRoot, '.adlc', 'current-ticket.json');
  if (!existsSync(path)) return { state: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { state: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || parsed.id.length === 0) {
    return { state: 'unreadable' };
  }
  return { state: 'active', id: parsed.id };
}

/**
 * Phase of the newest `.adlc/manifest.jsonl` record for `ticketId`
 * (uppercased), or null. Unparseable lines are skipped — the ledger is
 * append-only and its tail can be mid-write.
 */
export function readLatestPhase(repoRoot, ticketId) {
  const path = join(repoRoot, '.adlc', 'manifest.jsonl');
  if (!existsSync(path)) return null;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let phase = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.ticket === ticketId && typeof record?.data?.phase === 'string') {
      phase = record.data.phase.toUpperCase();
    }
  }
  return phase;
}

/**
 * Backlog counts from a ticket list. `completed:true` tickets are excluded
 * and satisfy edges (repo invariant #104). A ticket is blocked when a live
 * ticket holds an edge to it (edges live on the prerequisite); the active
 * ticket counts as in-flight.
 */
export function backlogCounts(tickets, activeId) {
  if (!Array.isArray(tickets)) return { ready: 0, inFlight: 0, blocked: 0 };
  const live = tickets.filter(
    (t) => t && typeof t === 'object' && typeof t.id === 'string' && t.completed !== true,
  );
  const blockedIds = new Set();
  for (const ticket of live) {
    for (const edge of Array.isArray(ticket.edges) ? ticket.edges : []) {
      if (edge && typeof edge.to === 'string') blockedIds.add(edge.to);
    }
  }
  let ready = 0;
  let inFlight = 0;
  let blocked = 0;
  for (const ticket of live) {
    if (ticket.id === activeId) inFlight += 1;
    else if (blockedIds.has(ticket.id)) blocked += 1;
    else ready += 1;
  }
  return { ready, inFlight, blocked };
}
