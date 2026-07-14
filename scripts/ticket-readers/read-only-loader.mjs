// GENERATED-LOADER SOURCE. Run `node scripts/ticket-readers/generate.mjs` after edits.
// Node built-ins only: installed hooks cannot assume a node_modules tree.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

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
  return Object.freeze({ backend, formatVersion: backend === 'legacy' ? 0 : 1, tickets: Object.freeze(copies), ticketHashes, hash: storeHash(copies) });
}

function loadLegacy(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} must be a non-symlink file`);
  const parent = lstatSync(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`${dirname(path)} must be a non-symlink directory`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`cannot parse ${path}: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tickets)) throw new Error(`${path} is not a legacy ticket envelope`);
  return snapshot('legacy', parsed.tickets);
}

function loadDirectory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} must be a non-symlink directory`);
  const parent = lstatSync(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`${dirname(path)} must be a non-symlink directory`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(path, '.store.json'), 'utf8')); } catch (error) { throw new Error(`cannot read ${path}/.store.json: ${error.message}`); }
  if (canonicalJson(manifest) !== canonicalJson(ACTIVE_MANIFEST)) throw new Error(`${path} has an unsupported store manifest`);
  const tickets = []; const lower = new Set();
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '.store.json') continue;
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error(`unrecognized ticket-store entry: ${entry.name}`);
    if (lower.has(entry.name.toLowerCase())) throw new Error(`case-insensitive shard collision: ${entry.name}`);
    lower.add(entry.name.toLowerCase());
    let ticket;
    try { ticket = JSON.parse(readFileSync(join(path, entry.name), 'utf8')); } catch (error) { throw new Error(`cannot parse shard ${entry.name}: ${error.message}`); }
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
