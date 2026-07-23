// Plain-file readers for a repo's `.adlc/` state (plan §5.1). Fail soft on
// absence, fail closed (explicit 'unreadable') on malformed data — never
// throw into the daemon. Structured ticket data beyond these files comes from
// the trusted `adlc` CLI, never from workspace imports (the installed plugin
// is a bare clone with no node_modules).
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { readActiveTicketPointer } from './generated-active-ticket.mjs';

/** Read the active-ticket pointer through the repo's generated reader — the
 *  pointer file is parsed in exactly ONE canonical place, and the
 *  ticket-store boundary guard enforces that nobody (including this plugin)
 *  hand-parses it. → {state:'absent'|'unreadable'} or {state:'active', id}. */
export function readActiveTicket(repoRoot) {
  let result;
  try {
    result = readActiveTicketPointer(repoRoot);
  } catch {
    return { state: 'unreadable' };
  }
  if (!result?.ok) return { state: 'unreadable' };
  if (!result.value?.present) return { state: 'absent' };
  if (typeof result.value.id !== 'string' || result.value.id.length === 0) return { state: 'unreadable' };
  return { state: 'active', id: result.value.id };
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
 * Extract the tickets array from an `adlc ticket store export` envelope.
 * `ticket list --json` is a projection WITHOUT `completed`/`edges` (verified
 * live 2026-07-23) — backlog math needs the full export. Fails soft (null)
 * on any other shape.
 */
export function ticketsFromExport(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.tickets)) return null;
  return parsed.tickets;
}

/**
 * Backlog counts from a ticket list. `completed:true` tickets are excluded
 * and satisfy edges (repo invariant #104). A ticket is blocked when a live
 * ticket holds an edge to it (edges live on the prerequisite); the active
 * ticket counts as in-flight.
 */
export function backlogCounts(tickets, activeId) {
  const groups = groupBacklog(tickets, activeId);
  return { ready: groups.ready.length, inFlight: groups.inFlight.length, blocked: groups.blocked.length };
}

/** Same semantics as backlogCounts, but returning the ticket groups
 *  themselves (for the board). */
export function groupBacklog(tickets, activeId) {
  const groups = { ready: [], inFlight: [], blocked: [] };
  if (!Array.isArray(tickets)) return groups;
  const live = tickets.filter(
    (t) => t && typeof t === 'object' && typeof t.id === 'string' && t.completed !== true,
  );
  const blockedIds = new Set();
  for (const ticket of live) {
    for (const edge of Array.isArray(ticket.edges) ? ticket.edges : []) {
      if (edge && typeof edge.to === 'string') blockedIds.add(edge.to);
    }
  }
  for (const ticket of live) {
    if (ticket.id === activeId) groups.inFlight.push(ticket);
    else if (blockedIds.has(ticket.id)) groups.blocked.push(ticket);
    else groups.ready.push(ticket);
  }
  return groups;
}

/** Default ledger-tail depth for display surfaces (the board). */
export const DEFAULT_LEDGER_ROWS = 8;

/** Last `n` parsed records of `.adlc/manifest.jsonl` (torn lines skipped). */
export function readLedgerTail(repoRoot, n = DEFAULT_LEDGER_ROWS) {
  if (!Number.isFinite(n) || n <= 0) return [];
  const path = join(repoRoot, '.adlc', 'manifest.jsonl');
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records.slice(-n);
}

/**
 * The most-recent ledger record PER TICKET (plan §5.2 / t-herdr-4: "most
 * recent gate-evidence records per ticket"), newest ticket-activity first,
 * capped at `n` tickets. A raw tail would let one hot ticket's burst hide
 * every other ticket's latest state — the opposite of the per-ticket view the
 * board promises. Records with no string `ticket` are dropped.
 */
export function readLedgerByTicket(repoRoot, n = DEFAULT_LEDGER_ROWS) {
  if (!Number.isFinite(n) || n <= 0) return [];
  const path = join(repoRoot, '.adlc', 'manifest.jsonl');
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const latestByTicket = new Map(); // ticket -> record (last occurrence wins)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record?.ticket !== 'string') continue;
    latestByTicket.delete(record.ticket); // re-insert so iteration order = recency of latest activity
    latestByTicket.set(record.ticket, record);
  }
  return [...latestByTicket.values()].slice(-n);
}

function defaultRunExport(repoRoot, outPath) {
  return new Promise((resolve) => {
    execFile('adlc', ['ticket', 'store', 'export', '--output', outPath], {
      cwd: repoRoot, timeout: 15_000, shell: false,
    }, (error) => resolve(!error));
  });
}

/**
 * Full ticket set via the trusted `adlc ticket store export` CLI (the
 * envelope with completed/edges — `ticket list --json` is a projection,
 * verified live 2026-07-23). Fails soft (null) on any failure. The exporter
 * is injectable for tests.
 *
 * The export file lives in a fresh private `mkdtempSync` directory (0700),
 * not a predictable name in the shared tmpdir — this reader runs on a 3s
 * board loop and on watcher heartbeats, so a predictable path would be a
 * co-tenant symlink/TOCTOU target (CWE-59/CWE-377). The whole directory is
 * removed in `finally`.
 */
export async function readTicketsViaExport(repoRoot, { runExport = defaultRunExport } = {}) {
  let outDir;
  try {
    outDir = mkdtempSync(join(tmpdir(), 'adlc-herdr-export-'));
  } catch {
    return null;
  }
  const outPath = join(outDir, 'store.json');
  try {
    const ok = await runExport(repoRoot, outPath);
    if (!ok) return null;
    return ticketsFromExport(JSON.parse(readFileSync(outPath, 'utf8')));
  } catch {
    return null;
  } finally {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
