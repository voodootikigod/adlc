// manifest-primitives.mjs — shared primitives for segmented gate-manifest
// and ticket-evidence lineage. Single-sourced in @adlc/tickets so both
// @adlc/gate-manifest and @adlc/tickets share identical definitions without cycles.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  unlinkSync,
  mkdirSync,
  constants as fsConstants,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { sha256, canonicalJson } from './canonical.mjs';

export const SEGMENT_DIRNAME = 'manifest.d';
export const SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
export const RESERVED_NAMES = new Set(['.store.json', '.lineage']);
export const MARKER_NAME = '.store.json';
export const LINEAGE_NAME = '.lineage';
export const MARKER_FORMAT = 'adlc-manifest-segments';
export const MARKER_VERSION = 1;
export const LOCK_SUFFIX = '.lock';
export const MAX_LOCAL_JSON_BYTES = 4096;
export const MAX_LOCK_OWNER_BYTES = 512;
export const MAX_FIRST_LINE_BYTES = 65536;
export const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const OVERSIZED_FIRST_ENTRY = Symbol('oversized-first-entry');
export const MALFORMED_FIRST_ENTRY = Symbol('malformed-first-entry');

export function segmentDirPath(dir = '.adlc') {
  return join(dir, SEGMENT_DIRNAME);
}

export function segmentPath(dir = '.adlc', name) {
  return join(segmentDirPath(dir), name);
}

export function markerPath(dir = '.adlc') {
  return join(segmentDirPath(dir), MARKER_NAME);
}

export function lineagePath(dir = '.adlc') {
  return join(segmentDirPath(dir), LINEAGE_NAME);
}

export function looksLikeGenuineLedgerLock(path, size) {
  if (size === 0) return true;
  if (size >= MAX_LOCK_OWNER_BYTES) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').trim());
  } catch {
    // leave parsed at null
  }
  return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
    && typeof parsed.token === 'string' && typeof parsed.pid === 'number'
    && typeof parsed.hostname === 'string' && typeof parsed.startedAt === 'string';
}

export function isSymlinkOrOtherNonRegular(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return false;
  }
  return !st.isFile();
}

export function readBoundedJsonNoFollow(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_LOCAL_JSON_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_LOCAL_JSON_BYTES, 0);
    if (bytesRead >= MAX_LOCAL_JSON_BYTES) return null;
    return JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function hasActivationMarker(dir = '.adlc') {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === 'object'
    && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}

export function rootEndsInCutover(dir = '.adlc') {
  const rootPath = join(dir, 'manifest.jsonl');
  if (!existsSync(rootPath)) return false;
  let content;
  try {
    content = readFileSync(rootPath, 'utf8');
  } catch {
    return false;
  }
  const lines = content.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return false;
  try {
    const last = JSON.parse(lines.at(-1));
    return Boolean(last) && typeof last === 'object' && last.gate === 'manifest-cutover';
  } catch {
    return false;
  }
}

export function isSegmentedRepo(dir = '.adlc') {
  return hasActivationMarker(dir) || rootEndsInCutover(dir);
}

export function discoverSegments(dir = '.adlc') {
  const segDir = segmentDirPath(dir);
  let dirStat;
  try {
    dirStat = lstatSync(segDir);
  } catch {
    return { valid: [], invalid: [] };
  }
  if (dirStat.isSymbolicLink()) {
    return { valid: [], invalid: [{ name: '.', reason: 'manifest.d/ is a symlink' }] };
  }
  if (!dirStat.isDirectory()) {
    return { valid: [], invalid: [{ name: '.', reason: 'manifest.d/ is not a directory' }] };
  }

  const valid = [];
  const invalid = [];
  const seenLower = new Map();

  let names;
  try {
    names = readdirSync(segDir).sort();
  } catch (err) {
    return { valid: [], invalid: [{ name: '.', reason: `cannot read manifest.d/: ${err.message}` }] };
  }

  for (const name of names) {
    if (RESERVED_NAMES.has(name)) continue;
    const full = join(segDir, name);
    let st;
    try {
      st = lstatSync(full);
    } catch (err) {
      invalid.push({ name, reason: `cannot stat: ${err.message}` });
      continue;
    }
    if (st.isSymbolicLink()) {
      invalid.push({ name, reason: 'symlink' });
      continue;
    }
    if (st.isDirectory()) {
      invalid.push({ name, reason: 'nested directory' });
      continue;
    }
    if (!st.isFile()) {
      invalid.push({ name, reason: 'not a regular file' });
      continue;
    }
    if (name.endsWith(LOCK_SUFFIX)) {
      if (looksLikeGenuineLedgerLock(full, st.size)) continue;
      invalid.push({ name, reason: 'lock-suffixed object is not a genuine advisory lock' });
      continue;
    }
    if (!SEGMENT_NAME_RE.test(name)) {
      invalid.push({ name, reason: 'bad filename grammar' });
      continue;
    }
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) {
      invalid.push({ name, reason: `case-colliding with ${seenLower.get(lower)}` });
      continue;
    }
    seenLower.set(lower, name);
    valid.push(name);
  }
  return { valid, invalid };
}

export function encodeUlidPart(value, width) {
  let remaining = BigInt(value);
  let output = '';
  for (let i = 0; i < width; i += 1) {
    output = ULID_ALPHABET[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}

export function generateSegmentUlid(now = Date.now(), entropy = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new RangeError('ULID timestamp out of range');
  if (!Buffer.isBuffer(entropy) || entropy.length !== 10) throw new TypeError('ULID entropy must be 10 bytes');
  const random = BigInt(`0x${entropy.toString('hex')}`);
  return `${encodeUlidPart(BigInt(now), 10)}${encodeUlidPart(random, 16)}`;
}

export function ulidOf(segmentName) {
  return segmentName.slice(segmentName.length - '.jsonl'.length - 26, segmentName.length - '.jsonl'.length);
}

export function deriveSlug(branchName) {
  const lowered = String(branchName ?? '').toLowerCase();
  const substituted = lowered.replace(/[^a-z0-9-]+/g, '-');
  const collapsed = substituted.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const truncated = collapsed.slice(0, 40).replace(/-+$/g, '');
  return truncated || 'segment';
}

export function currentBranch(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' || out === 'HEAD' ? null : out;
  } catch {
    return null;
  }
}

export function readLineageToken(dir = '.adlc') {
  const token = readBoundedJsonNoFollow(lineagePath(dir));
  if (!token || typeof token !== 'object') return null;
  if (typeof token.segment !== 'string' || typeof token.ulid !== 'string' || typeof token.branch !== 'string') return null;
  return token;
}

export function writeLineageToken(dir = '.adlc', token) {
  mkdirSync(segmentDirPath(dir), { recursive: true });
  const p = lineagePath(dir);
  if (isSymlinkOrOtherNonRegular(p)) unlinkSync(p);
  const fd = openSync(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try {
    writeFileSync(fd, JSON.stringify(token));
  } finally {
    closeSync(fd);
  }
}

export function peekOpenSegment(dir = '.adlc', { cwd = (dir && dir !== '.adlc' ? dirname(dir) : process.cwd()) } = {}) {
  const branch = currentBranch(cwd);
  const token = readLineageToken(dir);
  if (branch !== null && token && token.branch === branch) {
    const { valid } = discoverSegments(dir);
    if (valid.includes(token.segment) && ulidOf(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }
  return null;
}

export function firstEntryOf(dir = '.adlc', segmentName) {
  let fd;
  try {
    fd = openSync(segmentPath(dir, segmentName), fsConstants.O_RDONLY);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  }
  try {
    const buf = Buffer.alloc(MAX_FIRST_LINE_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_FIRST_LINE_BYTES, 0);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    const newlineIndex = chunk.indexOf('\n');
    if (newlineIndex === -1 && bytesRead >= MAX_FIRST_LINE_BYTES) return OVERSIZED_FIRST_ENTRY;
    const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    if (firstLine.trim() === '') return MALFORMED_FIRST_ENTRY;
    return JSON.parse(firstLine);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  } finally {
    closeSync(fd);
  }
}

/** This branch's open segment, never minting: the .lineage token's segment, else
 *  the single segment whose first entry's `branch` equals the current branch (the
 *  exact ref, not the lossy filename slug). Identity only — verifies no signature.
 *  null: detached HEAD or no match. Throws: several matches, any invalid object
 *  in manifest.d/, or an oversized/unreadable first entry. */
export function recoverOpenSegment(dir = '.adlc', { cwd = (dir && dir !== '.adlc' ? dirname(dir) : process.cwd()) } = {}) {
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;
  const branch = currentBranch(cwd);
  if (branch === null) return null;
  const discovered = discoverSegments(dir);
  if (discovered.invalid.length > 0) {
    throw new Error(
      `manifest.d/ contains ${discovered.invalid.length} non-conforming filesystem object(s) `
      + `(${discovered.invalid.map((i) => i.name).sort().join(', ')}) — one could be a disguised or `
      + `tampered segment belonging to this branch, so recovery refuses rather than guess`
    );
  }
  const candidates = [];
  for (const name of discovered.valid) {
    const first = firstEntryOf(dir, name);
    if (first === OVERSIZED_FIRST_ENTRY) {
      throw new Error(
        `segment ${name}'s first entry exceeds the ${MAX_FIRST_LINE_BYTES}-byte bounded-read cap — `
        + `its branch cannot be determined, so it cannot be safely excluded as a candidate either; refusing to guess`
      );
    }
    if (first === MALFORMED_FIRST_ENTRY) {
      throw new Error(
        `segment ${name}'s first entry could not be read or parsed — `
        + `its branch cannot be determined, so it cannot be safely excluded as a candidate either; refusing to guess`
      );
    }
    if (first?.branch === branch) candidates.push(name);
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous: ${candidates.length} committed segments declare branch "${branch}" as their own `
      + `(${candidates.sort().join(', ')}) and no local .lineage token disambiguates them — refusing to guess; `
      + `run \`adlc gate-manifest adopt\` to see the candidates and choose which lineage this checkout continues`
    );
  }
  return { name: candidates[0], isNew: false };
}

export function assertSegmentPathCommittable(dir = '.adlc', name) {
  const probeCwd = dirname(dir);
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const run = (args) => {
    try {
      execFileSync('git', args, { cwd: probeCwd, env, stdio: 'ignore' });
      return 0;
    } catch (err) {
      if (err.code === 'ENOENT') return 'no-git';
      return err.status ?? 'error';
    }
  };
  if (run(['rev-parse', '--is-inside-work-tree']) !== 0) return;
  const rel = relative(probeCwd, segmentPath(dir, name)).split(sep).join('/');
  const status = run(['check-ignore', '-q', '--', rel]);
  if (status === 0) {
    throw new Error(
      `refusing to mint segment ${name}: .gitignore would ignore its file, so evidence recorded there would exist `
      + 'only in this checkout — never in CI or any other clone; fix the ignore rules (gate-manifest enable names '
      + 'the required negation lines) and retry',
    );
  }
  if (status !== 1) {
    throw new Error(`git check-ignore failed while probing segment ${name} — cannot verify the segment is committable, refusing to record evidence blindly`);
  }
}

export function canonicalEntryBytes(entry) {
  if (entry.sigVersion === 2) {
    const { sig: _sig, segment: _segment, ...signed } = entry;
    return canonicalJson(signed);
  }
  const canonical = {
    seq: entry.seq,
    gate: entry.gate,
    ts: entry.ts,
  };
  if (entry.ticket !== undefined) canonical.ticket = entry.ticket;
  if (entry.data !== undefined) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return JSON.stringify(canonical);
}

export function entrySigValid(key, entry) {
  if (typeof entry?.sig !== 'string' || entry.sig.length === 0) return false;
  const expected = createHmac('sha256', key).update(canonicalEntryBytes(entry)).digest('hex');
  const a = Buffer.from(entry.sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const verifyEntrySig = entrySigValid;

function isChainIntact(lines, key) {
  if (lines.length === 0) return false;
  let prevLine = null;
  let prevSeq = 0;
  let seenSignedEntry = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (i === 0 && !Object.hasOwn(entry, 'anchor')) return false;
    if (i > 0 && Object.hasOwn(entry, 'anchor')) return false;
    const expectedPrev = prevLine === null ? null : sha256(prevLine);
    if (entry.prev !== expectedPrev || entry.seq !== prevSeq + 1) return false;
    if (key !== null) {
      const hasSig = typeof entry.sig === 'string' && entry.sig.length > 0;
      if (hasSig) {
        if (!entrySigValid(key, entry)) return false;
        seenSignedEntry = true;
      } else if (seenSignedEntry) {
        return false;
      }
    }
    prevLine = line;
    prevSeq = entry.seq;
  }
  return true;
}

export function resolveOpenSegment(dir = '.adlc', { cwd = (dir && dir !== '.adlc' ? dirname(dir) : process.cwd()), key = null } = {}) {
  const markerDoc = readBoundedJsonNoFollow(markerPath(dir));
  if (markerDoc && markerDoc.auth === 'keyed' && key === null) {
    throw new Error(
      'this forest was activated in keyed mode, but no signing key was provided for this write — an unsigned '
      + 'entry here would permanently strand every keyed clone of this branch; configure the manifest key',
    );
  }
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;

  if (key !== null) {
    const recovered = recoverOpenSegment(dir, { cwd });
    if (recovered) {
      let lines = [];
      const segFile = segmentPath(dir, recovered.name);
      if (existsSync(segFile)) {
        lines = readFileSync(segFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
      }
      let first = null;
      try {
        first = JSON.parse(lines[0]);
      } catch {
        // handled below
      }
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && entrySigValid(key, first);
      if (!isChainIntact(lines, key) || !firstAuthenticated) {
        throw new Error(
          `segment ${recovered.name} declares this branch but cannot be authenticated with the configured key `
          + '(broken chain, or its branch-bearing first entry lacks a verified v2 signature) — refusing to extend '
          + 'it, and refusing to mint a duplicate past it (that would silently fork this branch\'s lineage)',
        );
      }
      return recovered;
    }
  } else {
    let candidateExists = false;
    try {
      candidateExists = recoverOpenSegment(dir, { cwd }) !== null;
    } catch {
      candidateExists = true;
    }
    if (candidateExists) {
      throw new Error(
        'a committed segment already declares this branch, and with no signing key this writer can neither '
        + 'authenticate and extend it nor safely mint alongside it (a fresh token would shadow the committed '
        + 'evidence from every later read) — configure the manifest key, or restore the local .lineage token',
      );
    }
  }

  const branch = currentBranch(cwd);
  const rootPath = join(dir, 'manifest.jsonl');
  let rootLast = null;
  if (existsSync(rootPath)) {
    const rootLines = readFileSync(rootPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    rootLast = rootLines.at(-1) ?? null;
  }
  let anchor = null;
  if (rootLast !== null) {
    let lastEntry = null;
    try {
      lastEntry = JSON.parse(rootLast);
    } catch {
      // leave anchor null
    }
    if (lastEntry) anchor = { segment: 'root', seq: lastEntry.seq, lineHash: sha256(rootLast) };
  }
  const ulid = generateSegmentUlid();
  const slug = deriveSlug(branch ?? '');
  const name = `${slug}-${ulid}.jsonl`;
  assertSegmentPathCommittable(dir, name);
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  return { name, isNew: true, anchor, ...(branch !== null ? { branch } : {}) };
}
