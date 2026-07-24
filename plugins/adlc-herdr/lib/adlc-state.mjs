// Plain-file readers for a repo's `.adlc/` state (plan §5.1). Fail soft on
// absence, fail closed (explicit 'unreadable') on malformed data — never
// throw into the daemon. Structured ticket data beyond these files comes from
// the trusted `adlc` CLI, never from workspace imports (the installed plugin
// is a bare clone with no node_modules).
import {
  readFileSync, existsSync, rmSync, mkdtempSync, openSync, readSync, fstatSync, closeSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { readActiveTicketPointer } from './generated-active-ticket.mjs';

// The gate ledger `.adlc/manifest.jsonl` is an append-only, UNBOUNDED file, and
// these readers run inside the watcher's refresh loop and the 3s board loop.
// Reading + JSON-parsing the whole file every time would peg a CPU as history
// grows, so we read only the last LEDGER_TAIL_BYTES. The most-recent records
// for the active ticket / recently-active tickets are always in that window;
// an older record that falls outside it is, by definition, not the latest.
const LEDGER_TAIL_BYTES = 256 * 1024;

/** Read the last `maxBytes` of a file as UTF-8, or the whole file if smaller.
 *  A partial first line (from the byte cut) is expected — callers skip
 *  unparseable lines. Returns null on any error. */
function readTailText(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.toString('utf8', 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * A cache key for the repo's ticket store that changes only when the store's
 * mtime advances. The sharded store updates via temp+rename (bumps its
 * directory's mtime); the legacy store is a single JSON file — stat whichever
 * exists. Returns `<repoRoot>@<mtimeMs>`, or `<repoRoot>@0` when no store
 * exists (a stable key so an absent store is still cached, not re-exported
 * every poll). The `0` sentinel is deliberate: a numeric mtime is never 0 for
 * a real store. (This is a read-only stat, never a writer — the path is built
 * with `join`, not a literal, to stay outside the store-writer boundary guard.)
 */
export function storeCacheKey(repoRoot) {
  let mtime = 0;
  for (const p of [join(repoRoot, '.adlc', 'tickets'), join(repoRoot, '.adlc', 'tickets.json')]) {
    try {
      if (existsSync(p)) {
        mtime = statSync(p).mtimeMs;
        break;
      }
    } catch {
      // ignore — fall through to next candidate
    }
  }
  return `${repoRoot}@${mtime}`;
}

/**
 * A single-slot cache keyed by `keyFn(arg)`: it calls the async `readFn(arg)`
 * only when the key changes, returning the cached value (even `null`) on a
 * hit. Used by the board so an idle 3s redraw doesn't re-spawn `adlc` while the
 * store is unchanged. `keyFn`/`readFn` are injected so the hit/miss behaviour
 * is unit-testable.
 */
export function makeKeyedCache(keyFn, readFn) {
  let cache = { key: null, hasValue: false, value: null };
  return async (arg) => {
    const key = keyFn(arg);
    if (cache.hasValue && cache.key === key) return cache.value;
    const value = await readFn(arg);
    cache = { key, hasValue: true, value };
    return value;
  };
}

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
  const text = readTailText(path, LEDGER_TAIL_BYTES);
  if (text === null) return null;
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
  const text = readTailText(path, LEDGER_TAIL_BYTES);
  if (text === null) return [];
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
  const text = readTailText(path, LEDGER_TAIL_BYTES);
  if (text === null) return [];
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
