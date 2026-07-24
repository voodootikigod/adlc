// GENERATED-LOADER SOURCE. Run `node scripts/ticket-readers/generate.mjs` after edits.
// Node built-ins only: installed hooks cannot assume a node_modules tree.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, openSync, fstatSync, readSync, closeSync, opendirSync, constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

// Bounds for reads over a possibly-untrusted store path (issue #341): a FIFO must
// not block the loader and a giant file/directory must not exhaust memory. Non-
// regular files and over-cap directories FAIL CLOSED (throw) — for a trust root,
// silently skipping content would be a fail-OPEN enforcement hole (a dropped
// shard is a ticket, and its rails, that stop being seen).
const MAX_STORE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STORE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STORE_ENTRIES = 100_000;

// Read a REGULAR file without blocking: open O_NONBLOCK (a FIFO/device then never
// blocks), check the type on the OPEN fd (no stat→read TOCTOU), refuse an
// over-cap size, and read it. Throws on any of these — the callers already wrap
// reads in try/catch and rethrow as a store error.
export function readStoreFileBounded(path, max = MAX_STORE_FILE_BYTES, readImpl = readSync) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    throw new Error(`cannot open ${path}: ${error.message}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (stat.size > max) throw new Error(`${path} exceeds the ${max}-byte read cap`);
    const buf = Buffer.allocUnsafe(stat.size);
    // Loop: POSIX read(2) may return fewer bytes than requested (network/FUSE
    // rsize caps), so a single read could truncate a legitimate large shard.
    // `readImpl` is a test seam (defaults to the real readSync) so a short read
    // can be simulated deterministically.
    let read = 0;
    while (read < stat.size) {
      const n = readImpl(fd, buf, read, stat.size - read, read);
      if (n === 0) break; // end of file
      read += n;
    }
    return buf.toString('utf8', 0, read);
  } finally {
    try { closeSync(fd); } catch { /* best-effort: a throwing close must not mask the read */ }
  }
}

// Stream a directory's entries via opendirSync (never materializes an unbounded
// readdirSync array) and FAIL CLOSED past the cap: a store directory larger than
// this is treated as an error, not silently truncated to the first N shards.
export function readdirEntriesBounded(path, max = MAX_STORE_ENTRIES) {
  let dir;
  try {
    dir = opendirSync(path);
  } catch (error) {
    throw new Error(`cannot open directory ${path}: ${error.message}`);
  }
  try {
    const entries = [];
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (entries.length >= max) throw new Error(`ticket store directory ${path} exceeds ${max} entries`);
      entries.push(entry);
    }
    return entries;
  } finally {
    try { dir.closeSync(); } catch { /* best-effort */ }
  }
}

// Accumulate shard bytes and FAIL CLOSED past the aggregate cap: the per-file and
// per-entry caps still let many individually-under-cap shards sum to an OOM
// (e.g. 500 × 8MB = 4GB), so the running total is bounded too.
export function addBounded(total, bytes, max) {
  const next = total + bytes;
  if (next > max) throw new Error(`ticket store exceeds the ${max}-byte aggregate cap`);
  return next;
}

const ACTIVE_MANIFEST = { format: 'adlc-ticket-directory', version: 1 };
const TICKET_DOMAIN = 'adlc:ticket:v1\0';
const STORE_DOMAIN = 'adlc:active-store:v1\0';
const compare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, normalize(value[key])]));
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('ticket store contains a non-finite number');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new Error('ticket store contains a non-JSON value');
  return value;
};
const canonicalJson = (value) => JSON.stringify(normalize(value));
export const ticketHash = (ticket) => sha256(TICKET_DOMAIN + canonicalJson(ticket));
export const ticketFilename = (id) => {
  const slug = id.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '') || 'ticket';
  return `${slug}--${sha256(Buffer.from(id, 'utf8'))}.json`;
};
const storeHash = (tickets) => sha256(STORE_DOMAIN + canonicalJson(tickets.map((ticket) => [ticket.id, ticketHash(ticket)]).sort(([a], [b]) => compare(a, b))));

function validate(tickets) {
  if (!Array.isArray(tickets)) throw new Error('ticket store must contain a tickets array');
  const errors = [];
  const byId = new Map();
  for (const ticket of tickets) {
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) { errors.push('ticket is not an object'); continue; }
    if (typeof ticket.id !== 'string' || !ticket.id) errors.push('ticket missing string id');
    if (typeof ticket.title !== 'string' || !ticket.title) errors.push(`${ticket.id ?? '?'}: missing string title`);
    for (const field of ['scope', 'rails']) if (ticket[field] !== undefined && (!Array.isArray(ticket[field]) || ticket[field].some((item) => typeof item !== 'string'))) errors.push(`${ticket.id ?? '?'}: ${field} must be an array of strings`);
    if (ticket.edges !== undefined && (!Array.isArray(ticket.edges) || ticket.edges.some((edge) => !edge || typeof edge !== 'object' || typeof edge.to !== 'string' || !edge.to))) errors.push(`${ticket.id ?? '?'}: edges must contain string targets`);
    if (typeof ticket.id === 'string') { if (byId.has(ticket.id)) errors.push(`duplicate ticket id: ${ticket.id}`); byId.set(ticket.id, ticket); }
  }
  for (const ticket of tickets) for (const edge of ticket?.edges ?? []) if (!byId.has(edge.to)) errors.push(`${ticket.id}: edge to unknown ticket ${edge.to}`);
  const visiting = new Set(); const visited = new Set();
  const visit = (id) => { if (visiting.has(id)) { errors.push(`cycle in ticket DAG at ${id}`); return; } if (visited.has(id)) return; visiting.add(id); for (const edge of byId.get(id)?.edges ?? []) visit(edge.to); visiting.delete(id); visited.add(id); };
  for (const id of byId.keys()) visit(id);
  if (errors.length) throw new Error(`ticket store validation failed: ${errors.join('; ')}`);
}

function snapshot(backend, tickets) {
  validate(tickets);
  const copies = tickets.map((ticket) => Object.freeze(structuredClone(ticket))).sort((a, b) => compare(a.id, b.id));
  const ticketHashes = Object.freeze(Object.fromEntries(copies.map((ticket) => [ticket.id, ticketHash(ticket)])));
  // get(id) is part of the TicketSnapshot interface (spec §8.1). It was missing
  // here, so a generated snapshot was not substitutable for a domain one — any
  // shared consumer (e.g. the generated pointer reader) crashed on it.
  const byId = new Map(copies.map((ticket) => [ticket.id, ticket]));
  return Object.freeze({
    backend,
    formatVersion: backend === 'legacy' ? 0 : 1,
    tickets: Object.freeze(copies),
    ticketHashes,
    hash: storeHash(copies),
    get: (id) => byId.get(id),
  });
}

function loadLegacy(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} must be a non-symlink file`);
  const parent = lstatSync(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`${dirname(path)} must be a non-symlink directory`);
  let parsed;
  try { parsed = JSON.parse(readStoreFileBounded(path)); } catch (error) { throw new Error(`cannot parse ${path}: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tickets)) throw new Error(`${path} is not a legacy ticket envelope`);
  return snapshot('legacy', parsed.tickets);
}

function loadDirectory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} must be a non-symlink directory`);
  const parent = lstatSync(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`${dirname(path)} must be a non-symlink directory`);
  let manifest;
  try { manifest = JSON.parse(readStoreFileBounded(join(path, '.store.json'))); } catch (error) { throw new Error(`cannot read ${path}/.store.json: ${error.message}`); }
  if (canonicalJson(manifest) !== canonicalJson(ACTIVE_MANIFEST)) throw new Error(`${path} has an unsupported store manifest`);
  const tickets = []; const lower = new Set();
  let totalBytes = 0;
  for (const entry of readdirEntriesBounded(path)) {
    if (entry.name === '.store.json') continue;
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error(`unrecognized ticket-store entry: ${entry.name}`);
    if (lower.has(entry.name.toLowerCase())) throw new Error(`case-insensitive shard collision: ${entry.name}`);
    lower.add(entry.name.toLowerCase());
    let raw;
    try { raw = readStoreFileBounded(join(path, entry.name)); } catch (error) { throw new Error(`cannot parse shard ${entry.name}: ${error.message}`); }
    // Bound the AGGREGATE, not just each shard: many under-cap shards must not
    // sum to an OOM. Fail closed on the running total before parsing more.
    totalBytes = addBounded(totalBytes, Buffer.byteLength(raw, 'utf8'), MAX_STORE_TOTAL_BYTES);
    let ticket;
    try { ticket = JSON.parse(raw); } catch (error) { throw new Error(`cannot parse shard ${entry.name}: ${error.message}`); }
    if (!ticket || typeof ticket.id !== 'string' || entry.name !== ticketFilename(ticket.id)) throw new Error(`shard filename does not match ticket id: ${entry.name}`);
    tickets.push(ticket);
  }
  return snapshot('directory', tickets);
}

export function ticketStoreExists(root = '.', env = process.env) {
  const override = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS;
  if (override) return existsSync(isAbsolute(override) ? override : join(root, override));
  return existsSync(join(root, '.adlc/tickets.json')) || existsSync(join(root, '.adlc/tickets/.store.json'));
}

export function loadTicketStoreReadOnly({ root = '.', env = process.env } = {}) {
  const override = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS;
  if (override) {
    const path = isAbsolute(override) ? override : join(root, override);
    return path.endsWith('.json') ? loadLegacy(path) : loadDirectory(path);
  }
  const legacy = join(root, '.adlc/tickets.json');
  const directory = join(root, '.adlc/tickets');
  const hasLegacy = existsSync(legacy);
  const hasDirectory = existsSync(join(directory, '.store.json'));
  if (hasLegacy === hasDirectory) throw new Error(hasLegacy ? 'both legacy and directory ticket stores exist' : 'no supported ticket store found');
  return hasLegacy ? loadLegacy(legacy) : loadDirectory(directory);
}
