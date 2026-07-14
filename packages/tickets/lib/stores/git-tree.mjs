import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { ACTIVE_MANIFEST, LEGACY_FILE } from '../constants.mjs';
import { canonicalJson } from '../canonical.mjs';
import { invalid, operational } from '../errors.mjs';
import { ticketFilename } from '../filename.mjs';
import { validateTickets } from '../schema.mjs';
import { TicketSnapshot } from '../snapshot.mjs';

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0) return result.stdout;
  if (allowFailure) return null;
  if (result.error) throw operational('GIT_READ_FAILED', `git ${args[0]} failed: ${result.error.message}`);
  throw operational('GIT_READ_FAILED', `git ${args[0]} failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
}

export class GitTreeTicketStore {
  constructor({ cwd = '.', revision, storePath = '.adlc/tickets' }) {
    if (!revision) throw new TypeError('GitTreeTicketStore requires an exact revision');
    if (revision.startsWith('-') || /[\0\r\n]/.test(revision)) throw invalid('UNSAFE_GIT_REVISION', 'Git revision cannot be option-like or contain control characters');
    this.cwd = cwd;
    this.revision = revision;
    this.exactRevision = null;
    this.storePath = storePath.replace(/\\/g, '/').replace(/\/$/, '');
    if (!this.storePath || this.storePath.startsWith('/') || this.storePath.split('/').includes('..')) {
      throw invalid('UNSAFE_GIT_PATH', `ticket store path must be repository-relative: ${storePath}`);
    }
  }

  #show(path) {
    const output = runGit(this.cwd, ['show', `${this.exactRevision}:${path}`], { allowFailure: true });
    if (output === null) throw operational('GIT_PATH_MISSING', `${path} is absent at ${this.exactRevision}`);
    return output;
  }

  #entries(path) {
    const listing = runGit(this.cwd, ['ls-tree', '-r', '-z', this.exactRevision, '--', path]);
    return listing.split('\0').filter(Boolean).map((record) => {
      const separator = record.indexOf('\t');
      if (separator < 0) throw invalid('INVALID_GIT_TREE', `cannot parse Git tree entry at ${this.revision}`);
      const [mode, type, object] = record.slice(0, separator).split(' ');
      return { mode, type, object, path: record.slice(separator + 1) };
    });
  }

  #regularBlob(path) {
    const entries = this.#entries(path);
    const entry = entries.find((candidate) => candidate.path === path);
    if (!entry) return null;
    if (entry.type !== 'blob' || entry.mode !== '100644') {
      throw invalid('UNSAFE_GIT_MODE', `${path} at ${this.revision} must be a non-executable regular file`);
    }
    return entry;
  }

  load() {
    const resolved = runGit(this.cwd, ['rev-parse', '--verify', '--quiet', `${this.revision}^{commit}`], { allowFailure: true });
    if (resolved === null) {
      throw operational('GIT_REVISION_MISSING', `Git revision not found: ${this.revision}`);
    }
    this.exactRevision = resolved.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(this.exactRevision)) throw invalid('UNSAFE_GIT_REVISION', `Git did not resolve ${this.revision} to an object ID`);
    const legacyExists = this.#regularBlob(LEGACY_FILE) !== null;
    const manifestPath = posix.join(this.storePath, '.store.json');
    const directoryExists = this.#regularBlob(manifestPath) !== null;
    if (legacyExists === directoryExists) {
      throw invalid(legacyExists ? 'AMBIGUOUS_STORE' : 'STORE_NOT_FOUND', legacyExists
        ? `both legacy and directory ticket stores exist at ${this.revision}`
        : `no ticket store exists at ${this.revision}`);
    }
    if (legacyExists) {
      let parsed;
      try { parsed = JSON.parse(this.#show(LEGACY_FILE)); } catch (error) { throw invalid('INVALID_JSON', `invalid legacy store at ${this.revision}: ${error.message}`); }
      if (!parsed || !Array.isArray(parsed.tickets)) throw invalid('INVALID_ENVELOPE', `legacy store at ${this.revision} has no tickets array`);
      validateTickets(parsed.tickets);
      return new TicketSnapshot({ backend: 'git-revision', formatVersion: 0, tickets: parsed.tickets });
    }
    let manifest;
    try { manifest = JSON.parse(this.#show(manifestPath)); } catch (error) { throw invalid('INVALID_MANIFEST', `invalid directory manifest at ${this.revision}: ${error.message}`); }
    if (canonicalJson(manifest) !== canonicalJson(ACTIVE_MANIFEST)) throw invalid('UNSUPPORTED_STORE_FORMAT', `unsupported directory store at ${this.revision}`);
    const entries = this.#entries(this.storePath);
    const expectedPrefix = `${this.storePath}/`;
    const tickets = [];
    const seenLower = new Set();
    for (const entry of entries) {
      const { path } = entry;
      if (!path.startsWith(expectedPrefix)) throw invalid('UNSAFE_GIT_PATH', `unexpected Git tree path: ${path}`);
      const relative = path.slice(expectedPrefix.length);
      if (relative === '.store.json') {
        if (entry.type !== 'blob' || entry.mode !== '100644') throw invalid('UNSAFE_GIT_MODE', `${path} must be a non-executable regular file`);
        continue;
      }
      if (relative.includes('/') || !relative.endsWith('.json')) throw invalid('UNRECOGNIZED_STORE_ENTRY', `invalid ticket tree entry: ${relative}`);
      if (entry.type !== 'blob' || entry.mode !== '100644') throw invalid('UNSAFE_GIT_MODE', `${path} must be a non-executable regular file`);
      if (seenLower.has(relative.toLowerCase())) throw invalid('CASE_COLLISION', `case-insensitive collision at ${relative}`);
      seenLower.add(relative.toLowerCase());
      let ticket;
      try { ticket = JSON.parse(this.#show(path)); } catch (error) { throw invalid('INVALID_JSON', `invalid shard ${relative}: ${error.message}`); }
      if (!ticket || typeof ticket.id !== 'string' || relative !== ticketFilename(ticket.id)) throw invalid('FILENAME_MISMATCH', `${relative} does not match its ticket id`);
      tickets.push(ticket);
    }
    validateTickets(tickets);
    return new TicketSnapshot({ backend: 'git-revision', formatVersion: 1, tickets });
  }
}
