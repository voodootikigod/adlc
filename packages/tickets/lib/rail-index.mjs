import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256, ticketHash } from './canonical.mjs';
import { writeFileAtomic } from './durability.mjs';
import { CURRENT_TICKET_FILE, resolveActiveTicketAgainst, resolveActiveTicketId } from './pointer.mjs';
import { detectTicketStore } from './store.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';

export const ACTIVE_RAIL_INDEX_FILE = '.adlc/.active-rail-index.json';
const MAX_INDEX_BYTES = 1024 * 1024;

function cleanRails(rails) {
  if (!Array.isArray(rails)) return [];
  return rails.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
}

function filterActiveTickets(tickets) {
  const done = new Set(tickets.filter((t) => t.completed === true).map((t) => t.id));
  if (done.size === 0) return tickets;
  return tickets
    .filter((t) => !done.has(t.id))
    .map((t) =>
      Array.isArray(t.edges) && t.edges.some((e) => done.has(e.to))
        ? { ...t, edges: t.edges.filter((e) => !done.has(e.to)) }
        : t,
    );
}

function mergeActiveRails(active) {
  const railSet = new Set();
  for (const t of active) {
    for (const r of cleanRails(t.rails)) railSet.add(r);
  }
  return [...railSet];
}

function failResult(error) {
  return { ok: false, tickets: [], activeTicket: null, rails: [], boundTicket: false, source: 'error', error };
}

export function computeDirectoryStoreFingerprint(storePath) {
  try {
    const dirStat = lstatSync(storePath);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
    const entries = readdirSync(storePath, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let sawManifest = false;
    const lines = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) return null;
      if (entry.name === '.store.json') sawManifest = true;
      else if (!entry.name.endsWith('.json')) return null;
      const stat = lstatSync(join(storePath, entry.name));
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      lines.push(`${entry.name}:${stat.size}:${stat.mtimeMs}`);
    }
    if (!sawManifest) return null;
    return sha256(lines.join('\n'));
  } catch {
    return null;
  }
}

function tryReadCachedIndex(root, expectedFingerprint) {
  try {
    const indexPath = join(root, ACTIVE_RAIL_INDEX_FILE);
    const parentStat = lstatSync(dirname(indexPath));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return null;
    const stat = lstatSync(indexPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INDEX_BYTES) return null;
    const doc = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    if (doc.version !== 1 || doc.storeFingerprint !== expectedFingerprint) return null;
    if (!Array.isArray(doc.rails) || !Array.isArray(doc.activeTickets)) return null;
    if (!doc.rails.every((r) => typeof r === 'string')) return null;
    return { ok: true, tickets: doc.activeTickets, activeTicket: doc.activeTickets[0] ?? null, rails: doc.rails, boundTicket: false, source: 'index-cache', error: null };
  } catch {
    return null;
  }
}

function tryWriteCachedIndex(root, fingerprint, activeTickets, rails) {
  try {
    const indexPath = join(root, ACTIVE_RAIL_INDEX_FILE);
    const parentStat = lstatSync(dirname(indexPath));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return;
    writeFileAtomic(indexPath, `${JSON.stringify({ version: 1, storeFingerprint: fingerprint, activeTickets, rails })}\n`);
  } catch {
    // Best-effort cache write: tolerate EROFS/EACCES on read-only dirs or symlink refusal.
  }
}

export function readActiveRailIndex(root, { storeOverride = null, env = process.env, writeCache = false } = {}) {
  if (!root) return { ok: true, tickets: [], activeTicket: null, rails: [], boundTicket: false, source: 'none', error: null };

  let store;
  try {
    store = detectTicketStore({ root, ticketStore: storeOverride ?? undefined, allowRecovery: true, env });
  } catch (err) {
    return failResult(`ticket store unreadable: ${err?.message ?? String(err)}`);
  }

  const resolvedId = resolveActiveTicketId({ root, env });
  if (!resolvedId.ok) return failResult(`invalid active ticket selection: ${resolvedId.message ?? 'conflict'}`);

  const isDirectoryStore = store instanceof DirectoryTicketStore && typeof store.loadOne === 'function';

  // Fast Path 1: O(1) single-shard load when a ticket is bound on a directory store.
  if (resolvedId.value?.id && isDirectoryStore) {
    const { id, pointerPresent, ticketHash: pinnedHash, legacyString } = resolvedId.value;
    let ticket;
    try {
      ticket = store.loadOne(id);
    } catch (err) {
      return failResult(`ticket store unreadable: ${err?.message ?? String(err)}`);
    }
    if (ticket === null) return failResult(`invalid active ticket selection: active ticket "${id}" not found`);
    if (pointerPresent) {
      const expected = ticketHash(ticket);
      if (!pinnedHash) {
        const detail = legacyString ? 'a legacy bare-string pointer pins no ticketHash' : `${CURRENT_TICKET_FILE} pins no ticketHash`;
        return failResult(`invalid active ticket selection: ${detail}; expected ticketHash "${expected}"`);
      }
      if (pinnedHash !== expected) {
        return failResult(`invalid active ticket selection: active ticket "${id}" changed after selection (pointer pins ${pinnedHash}, store has ${expected})`);
      }
    }
    if (ticket.completed === true) return failResult(`active ticket "${ticket.id}" is already completed`);
    return { ok: true, tickets: [ticket], activeTicket: ticket, rails: cleanRails(ticket.rails), boundTicket: true, source: 'loadOne', error: null };
  }

  // Fast Path 2: O(1) index-cache read when no ticket is bound on a directory store.
  let fp = null;
  if (resolvedId.value === null && isDirectoryStore) {
    fp = computeDirectoryStoreFingerprint(store.path);
    if (fp !== null) {
      const cached = tryReadCachedIndex(root, fp);
      if (cached) return cached;
    }
  }

  // Fail-Closed Fallback: full store load.
  let snapshot;
  try {
    snapshot = store.load();
  } catch (err) {
    return failResult(`ticket store unreadable: ${err?.message ?? String(err)}`);
  }

  const active = filterActiveTickets(snapshot.tickets ?? []);
  const resolved = resolveActiveTicketAgainst(snapshot, { root, env });
  if (!resolved.ok) return failResult(`invalid active ticket selection: ${resolved.message ?? 'conflict'}`);

  if (resolved.value !== null) {
    const selected = resolved.value.ticket;
    if (selected.completed === true) return failResult(`active ticket "${selected.id}" is already completed`);
    return { ok: true, tickets: active, activeTicket: selected, rails: cleanRails(selected.rails), boundTicket: true, source: 'full-load', error: null };
  }

  const rails = mergeActiveRails(active);
  const activeTicket = active[0] ?? null;
  if (writeCache && fp) tryWriteCachedIndex(root, fp, active, rails);
  return { ok: true, tickets: active, activeTicket, rails, boundTicket: false, source: 'full-load', error: null };
}
