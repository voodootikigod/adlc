import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ACTIVE_DIRECTORY, ACTIVE_MANIFEST, ARCHIVE_DIRECTORY, ARCHIVE_MANIFEST } from '../constants.mjs';
import { invalid, operational } from '../errors.mjs';
import { canonicalJson } from '../canonical.mjs';
import { ticketFilename } from '../filename.mjs';
import { validateTickets } from '../schema.mjs';
import { TicketSnapshot } from '../snapshot.mjs';

function assertRealDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw operational('STORE_NOT_FOUND', `ticket store not found: ${path}`);
    throw operational('STORE_READ_FAILED', `cannot inspect ${path}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid('UNSAFE_STORE_PATH', `${path} must be a real directory`);
  const parent = dirname(path);
  if (parent !== path) {
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid('UNSAFE_STORE_PATH', `${parent} must be a real directory`);
  }
}

export class DirectoryTicketStore {
  constructor(path = ACTIVE_DIRECTORY, { archive = false } = {}) {
    this.path = path;
    this.archive = archive;
  }

  exists() {
    return existsSync(this.path);
  }

  load() {
    assertRealDirectory(this.path);
    const expectedManifest = this.archive ? ARCHIVE_MANIFEST : ACTIVE_MANIFEST;
    const entries = readdirSync(this.path, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
    if (names.size !== entries.length) throw invalid('CASE_COLLISION', `${this.path} contains case-insensitive name collisions`);
    const manifestEntry = entries.find((entry) => entry.name === '.store.json');
    if (!manifestEntry || !manifestEntry.isFile() || manifestEntry.isSymbolicLink()) throw invalid('INVALID_MANIFEST', `${this.path}/.store.json must be a regular file`);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(this.path, '.store.json'), 'utf8'));
    } catch (error) {
      throw invalid('INVALID_MANIFEST', `invalid store manifest: ${error.message}`);
    }
    if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
      const hint = Number.isInteger(manifest?.version) && manifest.version > 1 ? 'upgrade @adlc/tickets to read this store' : 'expected format version 1';
      throw invalid('UNSUPPORTED_STORE_FORMAT', `unsupported ticket store manifest (${hint})`, manifest);
    }
    const tickets = [];
    for (const entry of entries) {
      if (entry.name === '.store.json') continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
        throw invalid('UNRECOGNIZED_STORE_ENTRY', `unrecognized or unsafe ticket store entry: ${entry.name}`);
      }
      const fullPath = join(this.path, entry.name);
      const stat = lstatSync(fullPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw invalid('UNSAFE_SHARD', `${entry.name} must be a regular file`);
      let ticket;
      try {
        ticket = JSON.parse(readFileSync(fullPath, 'utf8'));
      } catch (error) {
        throw invalid('INVALID_JSON', `invalid JSON in ${entry.name}: ${error.message}`);
      }
      if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket) || typeof ticket.id !== 'string') {
        throw invalid('INVALID_SHARD', `${entry.name} must contain one ticket object`);
      }
      const expected = ticketFilename(ticket.id);
      if (entry.name !== expected) throw invalid('FILENAME_MISMATCH', `${entry.name} does not match ticket id ${ticket.id}; expected ${expected}`);
      tickets.push(ticket);
    }
    validateTickets(tickets, { archive: this.archive, validateGraph: !this.archive });
    return new TicketSnapshot({ backend: 'directory', formatVersion: 1, tickets });
  }

  resolvedPath() {
    return resolve(this.path);
  }
}

export const activeDirectoryStore = (root = '.') => new DirectoryTicketStore(join(root, ACTIVE_DIRECTORY));
export const archiveDirectoryStore = (root = '.') => new DirectoryTicketStore(join(root, ARCHIVE_DIRECTORY), { archive: true });
