import { createHmac } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sha256 } from './canonical.mjs';
import { writeFileAtomic } from './durability.mjs';
import { resolveKeyFromEnv } from './key-contract.mjs';
import {
  SIG_ALG_ED25519,
  canonicalEntryBytes,
  entrySigValid,
  isEd25519PrivateKey,
  readAdminPublicKey,
  signEntryEd25519,
} from './manifest-primitives.mjs';
import { resolveActiveTicketAgainst, resolveActiveTicketId } from './pointer.mjs';
import { detectTicketStore } from './store.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';

export const ACTIVE_RAIL_INDEX_FILE = '.adlc/.active-rail-index.json';
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_MEMORY_CACHE_ENTRIES = 64;

const memoryCache = new Map();

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
    const lowerNames = new Set();
    let sawManifest = false;
    const lines = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) return null;
      const lower = entry.name.toLowerCase();
      if (lowerNames.has(lower)) return null;
      lowerNames.add(lower);
      if (entry.name === '.store.json') sawManifest = true;
      else if (!entry.name.endsWith('.json')) return null;
      const stat = lstatSync(join(storePath, entry.name));
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      lines.push(`${entry.name}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
    }
    if (!sawManifest) return null;
    return sha256(lines.join('\n'));
  } catch {
    return null;
  }
}

function resolveVerifier(root, key, env) {
  const adminPub = readAdminPublicKey(join(root, '.adlc'));
  const publicKey = adminPub.status === 'ok' ? adminPub.publicKey : null;
  const verifyKey = key !== undefined ? key : resolveKeyFromEnv(env);
  return { verifyKey, publicKey };
}

function tryReadSignedIndex(root, expectedFingerprint, verifyKey, publicKey) {
  if (!verifyKey && !publicKey) return null;
  try {
    const indexPath = join(root, ACTIVE_RAIL_INDEX_FILE);
    const parentStat = lstatSync(dirname(indexPath));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return null;
    const stat = lstatSync(indexPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INDEX_BYTES) return null;
    const doc = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    if (doc.version !== 1 || doc.sigVersion !== 2 || doc.storeFingerprint !== expectedFingerprint) return null;
    if (!Array.isArray(doc.rails) || !Array.isArray(doc.activeTickets)) return null;
    if (!doc.rails.every((r) => typeof r === 'string')) return null;
    if (!entrySigValid(verifyKey, doc, { publicKey })) return null;
    return { ok: true, tickets: doc.activeTickets, activeTicket: doc.activeTickets[0] ?? null, rails: doc.rails, boundTicket: false, source: 'index-cache', error: null };
  } catch {
    return null;
  }
}

function tryWriteSignedIndex(root, fingerprint, activeTickets, rails, key) {
  if (typeof key !== 'string' || key.length === 0) return;
  try {
    const indexPath = join(root, ACTIVE_RAIL_INDEX_FILE);
    const parentStat = lstatSync(dirname(indexPath));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return;
    const doc = isEd25519PrivateKey(key)
      ? { version: 1, storeFingerprint: fingerprint, activeTickets, rails, sigVersion: 2, sigAlg: SIG_ALG_ED25519 }
      : { version: 1, storeFingerprint: fingerprint, activeTickets, rails, sigVersion: 2 };
    doc.sig = isEd25519PrivateKey(key)
      ? signEntryEd25519(key, doc)
      : createHmac('sha256', key).update(canonicalEntryBytes(doc)).digest('hex');
    writeFileAtomic(indexPath, `${JSON.stringify(doc)}\n`);
  } catch {
    // Best-effort cache write: tolerate EROFS/EACCES on read-only dirs or symlink refusal.
  }
}

function resolveFromSnapshot(snapshot, root, env, source) {
  const active = filterActiveTickets(snapshot.tickets ?? []);
  const resolved = resolveActiveTicketAgainst(snapshot, { root, env });
  if (!resolved.ok) return failResult(`invalid active ticket selection: ${resolved.message ?? 'conflict'}`);

  if (resolved.value !== null) {
    const selected = resolved.value.ticket;
    if (selected.completed === true) return failResult(`active ticket "${selected.id}" is already completed`);
    return { ok: true, tickets: active, activeTicket: selected, rails: cleanRails(selected.rails), boundTicket: true, source, error: null };
  }

  return { ok: true, tickets: active, activeTicket: active[0] ?? null, rails: mergeActiveRails(active), boundTicket: false, source, error: null };
}

function rememberSnapshot(storeKey, fingerprint, snapshot) {
  if (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES && !memoryCache.has(storeKey)) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
  memoryCache.set(storeKey, { storeFingerprint: fingerprint, snapshot });
}

export function readActiveRailIndex(root, { storeOverride = null, env = process.env, writeCache = false, key = undefined } = {}) {
  if (!root) return { ok: true, tickets: [], activeTicket: null, rails: [], boundTicket: false, source: 'none', error: null };

  let store;
  try {
    store = detectTicketStore({ root, ticketStore: storeOverride ?? undefined, allowRecovery: true, env });
  } catch (err) {
    return failResult(`ticket store unreadable: ${err?.message ?? String(err)}`);
  }

  const resolvedId = resolveActiveTicketId({ root, env });
  if (!resolvedId.ok) return failResult(`invalid active ticket selection: ${resolvedId.message ?? 'conflict'}`);

  const isDirectoryStore = store instanceof DirectoryTicketStore;
  const storeKey = isDirectoryStore ? resolve(store.path) : null;
  const fp = isDirectoryStore ? computeDirectoryStoreFingerprint(store.path) : null;
  const { verifyKey, publicKey } = resolveVerifier(root, key, env);

  // Fast Path 1: O(1) verified in-process cache keyed by storePath + fingerprint.
  if (fp !== null && storeKey !== null) {
    const mem = memoryCache.get(storeKey);
    if (mem && mem.storeFingerprint === fp) {
      return resolveFromSnapshot(mem.snapshot, root, env, 'memory-cache');
    }
    // Fast Path 2: O(1) cryptographically signed on-disk index when unbound.
    if (resolvedId.value === null) {
      const cached = tryReadSignedIndex(root, fp, verifyKey, publicKey);
      if (cached) return cached;
    }
  }

  // Fail-Closed Fallback: full store load (validates every shard and graph integrity).
  let snapshot;
  try {
    snapshot = store.load();
  } catch (err) {
    return failResult(`ticket store unreadable: ${err?.message ?? String(err)}`);
  }

  if (fp !== null && storeKey !== null) rememberSnapshot(storeKey, fp, snapshot);
  const result = resolveFromSnapshot(snapshot, root, env, 'full-load');
  if (result.ok && !result.boundTicket && writeCache && fp !== null) {
    tryWriteSignedIndex(root, fp, result.tickets, result.rails, verifyKey);
  }
  return result;
}
