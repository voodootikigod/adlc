import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { ACTIVE_MANIFEST, LEGACY_FILE } from '../constants.mjs';
import { canonicalJson } from '../canonical.mjs';
import { invalid, operational } from '../errors.mjs';
import { ticketFilename } from '../filename.mjs';
import { validateTickets } from '../schema.mjs';
import { TicketSnapshot } from '../snapshot.mjs';

const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function runGit(cwd, args, opts = {}) {
  const { allowFailure, spawnFn, encoding = 'utf8', input } = opts;
  const spawnOpts = { cwd, encoding, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER };
  if (input !== undefined) spawnOpts.input = input;
  const result = spawnFn('git', args, spawnOpts);
  if (result.status === 0) return result.stdout;
  if (result.error) throw operational('GIT_READ_FAILED', `git ${args[0]} failed: ${result.error.message}`);
  if (result.signal) throw operational('GIT_READ_FAILED', `git ${args[0]} timed out or was killed by ${result.signal}`);
  if (allowFailure) return null;
  const stderrText = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : result.stderr?.trim();
  throw operational('GIT_READ_FAILED', `git ${args[0]} failed: ${stderrText || `exit ${result.status}`}`);
}

function splitNulUtf8(raw, revision) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  const records = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i += 1) {
    if (i === buf.length || buf[i] === 0) {
      if (i > start) {
        const slice = buf.subarray(start, i);
        const decoded = slice.toString('utf8');
        if (!Buffer.from(decoded, 'utf8').equals(slice)) {
          throw invalid('UNSAFE_GIT_PATH', `non-UTF-8 Git tree path at ${revision}`);
        }
        records.push(decoded);
      }
      start = i + 1;
    }
  }
  return records;
}

function parseCatFileBatch(raw, expectedCount, revision) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  const blobs = [];
  let offset = 0;
  for (let idx = 0; idx < expectedCount; idx += 1) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) throw operational('GIT_READ_FAILED', `truncated git cat-file --batch header at ${revision}`);
    const header = buf.subarray(offset, nl).toString('utf8');
    const parts = header.split(' ');
    if (parts.length !== 3 || parts[1] !== 'blob') {
      throw operational('GIT_PATH_MISSING', `unexpected git cat-file --batch header at ${revision}: ${header}`);
    }
    const size = Number(parts[2]);
    if (!Number.isInteger(size) || size < 0) {
      throw operational('GIT_READ_FAILED', `invalid git cat-file --batch size at ${revision}: ${header}`);
    }
    const bodyStart = nl + 1;
    const bodyEnd = bodyStart + size;
    if (bodyEnd + 1 > buf.length || buf[bodyEnd] !== 0x0a) {
      throw operational('GIT_READ_FAILED', `truncated git cat-file --batch body at ${revision}`);
    }
    blobs.push(buf.subarray(bodyStart, bodyEnd).toString('utf8'));
    offset = bodyEnd + 1;
  }
  return blobs;
}

export class GitTreeTicketStore {
  constructor({ cwd = '.', revision, spawnFn = spawnSync, storePath = '.adlc/tickets' }) {
    if (!revision) throw new TypeError('GitTreeTicketStore requires an exact revision');
    if (revision.startsWith('-') || /[\0\r\n]/.test(revision)) throw invalid('UNSAFE_GIT_REVISION', 'Git revision cannot be option-like or contain control characters');
    this.cwd = cwd;
    this.revision = revision;
    this.exactRevision = null;
    this.spawnFn = spawnFn;
    this.storePath = storePath.replace(/\\/g, '/').replace(/\/$/, '');
    if (!this.storePath || this.storePath.startsWith('/') || this.storePath.split('/').includes('..')) {
      throw invalid('UNSAFE_GIT_PATH', `ticket store path must be repository-relative: ${storePath}`);
    }
  }

  #show(path) {
    const output = runGit(this.cwd, ['show', `${this.exactRevision}:${path}`], { allowFailure: true, spawnFn: this.spawnFn });
    if (output === null) throw operational('GIT_PATH_MISSING', `${path} is absent at ${this.exactRevision}`);
    return output;
  }

  #entries(path) {
    const listing = runGit(this.cwd, ['ls-tree', '-r', '-z', this.exactRevision, '--', path], { encoding: null, spawnFn: this.spawnFn });
    return splitNulUtf8(listing, this.revision).map((record) => {
      const separator = record.indexOf('\t');
      if (separator < 0) throw invalid('INVALID_GIT_TREE', `cannot parse Git tree entry at ${this.revision}`);
      const [mode, type, object] = record.slice(0, separator).split(' ');
      return { mode, type, object, path: record.slice(separator + 1) };
    });
  }

  #catFileBatch(objects) {
    if (objects.length === 0) return [];
    const input = `${objects.join('\n')}\n`;
    const raw = runGit(this.cwd, ['cat-file', '--batch'], { encoding: null, input, spawnFn: this.spawnFn });
    return parseCatFileBatch(raw, objects.length, this.revision);
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
    const resolved = runGit(this.cwd, ['rev-parse', '--verify', '--quiet', `${this.revision}^{commit}`], { allowFailure: true, spawnFn: this.spawnFn });
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
    const shardEntries = [];
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
      shardEntries.push({ relative, object: entry.object });
    }
    const blobs = this.#catFileBatch(shardEntries.map((item) => item.object));
    const tickets = [];
    for (let i = 0; i < shardEntries.length; i += 1) {
      const { relative } = shardEntries[i];
      let ticket;
      try { ticket = JSON.parse(blobs[i]); } catch (error) { throw invalid('INVALID_JSON', `invalid shard ${relative}: ${error.message}`); }
      if (!ticket || typeof ticket.id !== 'string' || relative !== ticketFilename(ticket.id)) throw invalid('FILENAME_MISMATCH', `${relative} does not match its ticket id`);
      tickets.push(ticket);
    }
    validateTickets(tickets);
    return new TicketSnapshot({ backend: 'git-revision', formatVersion: 1, tickets });
  }
}
