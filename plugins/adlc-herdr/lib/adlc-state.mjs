// Plain-file readers for a repo's `.adlc/` state (plan §5.1). Fail soft on
// absence, fail closed (explicit 'unreadable') on malformed data — never
// throw into the daemon. Structured ticket data beyond these files comes from
// the trusted `adlc` CLI, never from workspace imports (the installed plugin
// is a bare clone with no node_modules).
import {
  readFileSync, existsSync, rmSync, mkdtempSync, openSync, readSync, fstatSync, closeSync, statSync, opendirSync,
  constants as fsConstants,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';

/**
 * List up to `maxEntries` names in a directory via a streaming `opendirSync`
 * iterator — never allocates an array of ALL entries, so an attacker-supplied
 * directory with millions of files can't OOM the process. Returns [] on any
 * error (missing dir, not a dir, etc.).
 */
export function readdirBounded(dir, maxEntries) {
  let handle;
  try {
    handle = opendirSync(dir);
    try {
      const names = [];
      while (names.length < maxEntries) {
        const entry = handle.readSync();
        if (entry === null) break; // directory exhausted
        names.push(entry.name);
      }
      return names;
    } finally {
      handle.closeSync();
    }
  } catch {
    return [];
  }
}

// Hard cap on shard-directory entries scanned (DoS bound for an untrusted root).
const MAX_SHARD_ENTRIES = 100_000;

/**
 * Read up to `maxBytes` of a REGULAR file, safely, from a possibly-untrusted
 * path. Opens with O_NONBLOCK so opening a FIFO/device never blocks, then
 * checks the type on the OPEN fd (no stat→read TOCTOU: the fd is bound to the
 * inode even if the path is swapped) and reads a bounded amount. Returns null
 * for a non-regular file or any error.
 */
function readRegularFileBounded(path, maxBytes) {
  let fd;
  try {
    // open is OUTSIDE the inner try: if it throws, the outer catch handles it
    // and there is no descriptor to close (so no `fd !== undefined` guard to
    // get flipped). Inside, fd is always valid, so close is unconditional.
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return null; // FIFO/dir/device → don't read
      const length = Math.min(st.size, maxBytes);
      const buf = Buffer.allocUnsafe(length);
      // One bounded read — a regular file of this size fills in a single call;
      // a (pathological) short read just yields partial JSON that fails to parse.
      const n = readSync(fd, buf, 0, length, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
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

/**
 * Ticket ids present in a repo's store, read DIRECTLY from the filesystem —
 * never by spawning a subprocess with the (untrusted, event-supplied) repo as
 * cwd. Reading directory entries and files is a pure read: an attacker who
 * controls the directory cannot gain code execution from it (unlike running a
 * config-loading CLI there). Sharded store: `<id>--<hash>.json` filenames.
 * Legacy store: the `tickets` array in the flat `tickets.json`. Fails soft to
 * []. (The store path is assembled with `join`, never written as a literal, so
 * this reader stays clear of the ticket-store writer-boundary heuristic.)
 */
export function ticketIdsFromStore(repoRoot) {
  // Require an ABSOLUTE path: a relative one (''/'.'/'./x') from an untrusted
  // event payload would `join` against the process CWD and leak the HOST's
  // store, not the worktree's. herdr supplies absolute worktree roots.
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) return [];
  const ids = new Set();
  const shardDir = join(repoRoot, '.adlc', 'tickets');
  // `readdirBounded` fails soft to [] (missing/oversized dir), and every loop
  // operation below acts on a string entry name, so this scan cannot throw —
  // no try/catch needed around it (a dead catch would be an equivalent mutant).
  for (const name of readdirBounded(shardDir, MAX_SHARD_ENTRIES)) {
    if (!name.endsWith('.json')) continue;
    // `<id>--<64-hex-hash>.json`. The id may itself contain '--' (e.g.
    // `bug--login`), and a hand-copied file may have NO hash at all
    // (`bug--login.json`). Disambiguate by shape: the trailing segment is
    // the separator's hash ONLY if it's a 64-hex sha256; otherwise the whole
    // base name (minus .json) is the id.
    const base = name.slice(0, -'.json'.length);
    const sep = base.lastIndexOf('--');
    const id = sep >= 0 && /^[0-9a-f]{64}$/.test(base.slice(sep + 2)) ? base.slice(0, sep) : base;
    if (id) ids.add(id);
  }
  const legacy = join(repoRoot, '.adlc', 'tickets.json');
  try {
    // Non-blocking, type-checked-on-fd, size-bounded read: an attacker-supplied
    // FIFO can't block us and can't be swapped in via a stat→read TOCTOU, and a
    // giant file can't exhaust memory.
    const text = readRegularFileBounded(legacy, 8 * 1024 * 1024);
    if (text !== null) {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed?.tickets) ? parsed.tickets : [];
      for (const t of list) if (typeof t?.id === 'string') ids.add(t.id);
    }
  } catch {
    // malformed legacy store → ignore
  }
  return [...ids];
}

/** Read `.adlc/fleet-status.json` (the versioned fleet observation surface,
 *  t-herdr-8), bounded + non-blocking + fail-soft. Returns the parsed status
 *  object, or null when absent / unreadable / malformed. The planner
 *  (fleet-bridge) validates schemaVersion and the ids before acting on it. */
export function readFleetStatus(repoRoot) {
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) return null;
  const text = readRegularFileBounded(join(repoRoot, '.adlc', 'fleet-status.json'), 8 * 1024 * 1024);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
