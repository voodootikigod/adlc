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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256 } from './canonical.mjs';
import {
  ADMIN_PUB_FILENAME,
  ED25519_PRIV_PREFIX,
  SIG_ALG_ED25519,
  canonicalEntryBytes,
  generateEd25519KeyPair,
  isEd25519PrivateKey,
  derivePublicKeyPem,
  signEntryEd25519,
  verifyEntryEd25519,
  readAdminPublicKey,
} from './manifest-crypto.mjs';

export {
  ADMIN_PUB_FILENAME,
  ED25519_PRIV_PREFIX,
  SIG_ALG_ED25519,
  canonicalEntryBytes,
  generateEd25519KeyPair,
  isEd25519PrivateKey,
  derivePublicKeyPem,
  signEntryEd25519,
  verifyEntryEd25519,
  readAdminPublicKey,
};

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

/**
 * Normalize `(dir, opts)` across both calling conventions used in ADLC:
 * 1. Explicit target checkout `{ cwd }` with default/relative `dir` (e.g.
 *    `dir = ".adlc", cwd = "/other/repo"` -> `dir = "/other/repo/.adlc"`).
 * 2. Multi-segment relative `dir` whose `opts.cwd` came from `dirname(dir)`
 *    (e.g. `record.mjs` passing `dir = ".worktrees/lane-a/.adlc",
 *    cwd = ".worktrees/lane-a"` -> `dir = "<pwd>/.worktrees/lane-a/.adlc"`,
 *    never double-joining `.worktrees/lane-a/.worktrees/lane-a/.adlc`).
 * 3. Omitted `opts.cwd` with an explicit `dir` (e.g. `"/other/repo/.adlc"` or
 *    `".worktrees/lane-a/.adlc"` -> `cwd = dirname(resolve(dir))`).
 */
export function normalizeManifestDirAndCwd(dir = '.adlc', opts = {}) {
  const effectiveDir = dir ?? '.adlc';
  if (opts?.cwd === undefined || opts?.cwd === null) {
    const resolvedDir = resolve(effectiveDir);
    const defaultCwd = effectiveDir === '.adlc' ? process.cwd() : dirname(resolvedDir);
    return { dir: resolvedDir, cwd: defaultCwd };
  }
  const resolvedCwd = resolve(opts.cwd);
  const resolvedDir = isAbsolute(effectiveDir)
    ? resolve(effectiveDir)
    : effectiveDir !== '.adlc' && resolve(dirname(effectiveDir)) === resolvedCwd
      ? resolve(effectiveDir)
      : resolve(resolvedCwd, effectiveDir);
  return { dir: resolvedDir, cwd: resolvedCwd };
}

export function peekOpenSegment(dir = '.adlc', opts = {}) {
  ({ dir, cwd: opts } = normalizeManifestDirAndCwd(dir, opts));
  const cwd = opts;
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
export function recoverOpenSegment(dir = '.adlc', opts = {}) {
  let cwd;
  ({ dir, cwd } = normalizeManifestDirAndCwd(dir, opts));
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

export function assertSegmentPathCommittable(dir = '.adlc', name, opts = {}) {
  let probeCwd;
  ({ dir, cwd: probeCwd } = normalizeManifestDirAndCwd(dir, opts));
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.ADLC_MANIFEST_PRIVATE_KEY;
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

export function entrySigValid(key, entry, { publicKey = null } = {}) {
  if (typeof entry?.sig !== 'string' || entry.sig.length === 0) return false;
  if (entry.sigAlg === SIG_ALG_ED25519) {
    let verifierKey = publicKey;
    if (verifierKey === null && isEd25519PrivateKey(key)) {
      try {
        verifierKey = derivePublicKeyPem(key);
      } catch {
        return false;
      }
    }
    if (typeof verifierKey !== 'string' || verifierKey.length === 0) return false;
    return verifyEntryEd25519(verifierKey, entry);
  }
  if (entry.sigAlg !== undefined) return false;
  if (key === null || typeof key !== 'string' || key.length === 0 || isEd25519PrivateKey(key)) {
    return false;
  }
  const expected = createHmac('sha256', key).update(canonicalEntryBytes(entry)).digest('hex');
  const a = Buffer.from(entry.sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const verifyEntrySig = entrySigValid;

export function readRawLines(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .map((line, i) => ({ line, lineNo: i + 1 }))
    .filter(({ line }) => line.trim() !== '');
}

export function resolveAnchor(anchor, chainsBySeq, rootExists) {
  if (anchor === null) {
    if (rootExists) return { ok: false, reason: 'anchor: null is not permitted once a root exists' };
    return { ok: true };
  }
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return { ok: false, reason: 'anchor must be an object or null' };
  }
  const { segment, seq, lineHash } = anchor;
  if (typeof segment !== 'string' || segment === '') {
    return { ok: false, reason: 'anchor.segment must be a non-empty string' };
  }
  if (!Number.isInteger(seq) || seq < 1) {
    return { ok: false, reason: 'anchor.seq must be a positive integer' };
  }
  if (typeof lineHash !== 'string' || lineHash === '') {
    return { ok: false, reason: 'anchor.lineHash must be a non-empty string' };
  }
  const target = chainsBySeq.get(segment);
  if (!target) return { ok: false, reason: `dangling anchor: no such segment '${segment}' in the forest` };
  const rawLine = target.get(seq);
  if (rawLine === undefined) return { ok: false, reason: `dangling anchor: segment '${segment}' has no entry with seq ${seq}` };
  if (sha256(rawLine) !== lineHash) return { ok: false, reason: `anchor lineHash mismatch for '${segment}' seq ${seq}` };
  return { ok: true };
}

export function detectAnchorCycle(anchorBySegment) {
  const state = new Map();
  for (const start of anchorBySegment.keys()) {
    if (state.get(start) === 'done') continue;
    const path = [];
    let current = start;
    while (current !== undefined) {
      if (state.get(current) === 'visiting') return { ok: false, segment: current };
      if (state.get(current) === 'done') break;
      if (!anchorBySegment.has(current)) break;
      state.set(current, 'visiting');
      path.push(current);
      const anchor = anchorBySegment.get(current);
      current = anchor === null ? undefined : anchor.segment;
    }
    for (const seg of path) state.set(seg, 'done');
  }
  return { ok: true };
}

export function orderSegmentNames(segmentNames, anchorBySegment) {
  const depthCache = new Map();
  function depthOf(name, seen = new Set()) {
    if (depthCache.has(name)) return depthCache.get(name);
    if (seen.has(name)) return 0;
    seen.add(name);
    const anchor = anchorBySegment.get(name);
    const target = anchor?.segment;
    const depth = target && target !== 'root' && anchorBySegment.has(target) ? depthOf(target, seen) + 1 : 0;
    depthCache.set(name, depth);
    return depth;
  }

  return [...segmentNames].sort((a, b) => {
    const depthDiff = depthOf(a) - depthOf(b);
    if (depthDiff !== 0) return depthDiff;
    const aa = anchorBySegment.get(a);
    const bb = anchorBySegment.get(b);
    const aSeg = aa?.segment ?? '';
    const bSeg = bb?.segment ?? '';
    if (aSeg !== bSeg) return aSeg < bSeg ? -1 : 1;
    const aSeq = aa?.seq ?? 0;
    const bSeq = bb?.seq ?? 0;
    if (aSeq !== bSeq) return aSeq - bSeq;
    const aUlid = ulidOf(a);
    const bUlid = ulidOf(b);
    if (aUlid !== bUlid) return aUlid < bUlid ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function validateForestMarker(dir = '.adlc') {
  const path = markerPath(dir);
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, present: false, auth: null };
    return { ok: false, reason: `cannot stat .store.json: ${err.message}` };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
  const parsed = readBoundedJsonNoFollow(path);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid or oversized .store.json marker' };
  }
  if (parsed.format !== MARKER_FORMAT || parsed.version !== MARKER_VERSION) {
    return { ok: false, reason: 'invalid .store.json format or version' };
  }
  if (parsed.auth !== undefined && parsed.auth !== 'keyed' && parsed.auth !== 'keyless') {
    return { ok: false, reason: 'invalid .store.json auth mode' };
  }
  return { ok: true, present: true, auth: parsed.auth ?? null };
}

export function hasManifestCutoverTail(rootRaw) {
  if (!Array.isArray(rootRaw) || rootRaw.length === 0) return false;
  try {
    const last = JSON.parse(rootRaw.at(-1).line);
    return Boolean(last) && typeof last === 'object' && last.gate === 'manifest-cutover';
  } catch {
    return false;
  }
}

export function checkForestSignedEra({
  declaredAuth = null,
  rootEmpty = false,
  rootCutover = false,
  segmentNames,
  anchorBySegment,
  rootSawSigned,
  rootFirstUnsigned = null,
  segmentResults,
}) {
  if (declaredAuth === 'keyed' && !rootSawSigned && rootFirstUnsigned) {
    return { ok: false, segment: 'root', firstUnsigned: rootFirstUnsigned };
  }
  const ordered = orderSegmentNames(segmentNames, anchorBySegment);
  const anySegmentSigned = ordered.some((name) => Boolean(segmentResults.get(name)?.sawSignedEntry));
  const keyedForest =
    declaredAuth === 'keyed' ||
    (declaredAuth === null && Boolean(rootCutover) && Boolean(rootSawSigned)) ||
    (declaredAuth !== 'keyless' && Boolean(rootEmpty) && anySegmentSigned);
  const signedSegments = new Set();
  for (const name of ordered) {
    const res = segmentResults.get(name);
    const anchor = anchorBySegment.get(name);
    const parentSeg = anchor && anchor.segment !== 'root' ? anchor.segment : null;
    const parentInSignedEra = keyedForest || (parentSeg !== null && signedSegments.has(parentSeg));
    if (parentInSignedEra && res?.firstUnsigned) {
      return { ok: false, segment: name, firstUnsigned: res.firstUnsigned };
    }
    if (parentInSignedEra || res?.sawSignedEntry) {
      signedSegments.add(name);
    }
  }
  return { ok: true };
}

export function checkForestEd25519Era({
  segmentNames,
  anchorBySegment,
  rootSawEd25519,
  segmentResults,
}) {
  const ordered = orderSegmentNames(segmentNames, anchorBySegment);
  const ed25519Segments = new Set();
  for (const name of ordered) {
    const res = segmentResults.get(name);
    const anchor = anchorBySegment.get(name);
    const parentSeg = anchor && anchor.segment !== 'root' ? anchor.segment : null;
    const parentInEd25519Era =
      (anchor?.segment === 'root' && Boolean(rootSawEd25519)) ||
      (parentSeg !== null && ed25519Segments.has(parentSeg));
    if (parentInEd25519Era && res?.firstNonEd25519) {
      return { ok: false, segment: name, firstNonEd25519: res.firstNonEd25519 };
    }
    if (parentInEd25519Era || res?.sawEd25519Entry) {
      ed25519Segments.add(name);
    }
  }
  return { ok: true };
}

export function isUnsignedKeyedRoot(declaredAuth, key, requireSignatures, rootResult) {
  return (
    key !== null &&
    !isEd25519PrivateKey(key) &&
    !requireSignatures &&
    declaredAuth === 'keyed' &&
    rootResult.valid &&
    rootResult.count > 0 &&
    !rootResult.sawSignedEntry &&
    rootResult.firstUnsigned !== null
  );
}

export function verifyChain(
  nonEmpty,
  {
    key = null,
    publicKey = null,
    requireSignatures = false,
    anchorOnFirst = false,
    allowPreEd25519Only = false,
  } = {},
) {
  if (nonEmpty.length === 0) {
    if (anchorOnFirst) {
      return {
        valid: false,
        message: 'empty segment file has no first entry to carry the required anchor',
        count: 0,
        signed: false,
        break: { seq: null, lineNo: null, reason: 'empty segment file' },
        lastRawLine: null,
        firstAnchor: undefined,
        sawSignedEntry: false,
        firstUnsigned: null,
        sawEd25519Entry: false,
        firstNonEd25519: null,
      };
    }
    return {
      valid: true,
      message: 'empty manifest',
      count: 0,
      signed: false,
      break: null,
      lastRawLine: null,
      firstAnchor: undefined,
      sawSignedEntry: false,
      firstUnsigned: null,
      sawEd25519Entry: false,
      firstNonEd25519: null,
    };
  }

  const hasHmacKey = key !== null && !isEd25519PrivateKey(key);
  const hasEd25519Verifier = publicKey !== null || isEd25519PrivateKey(key);
  const hasAnyVerifier = hasHmacKey || hasEd25519Verifier;

  let prevRawLine = null;
  let prevSeq = null;
  let firstAnchor;
  let seenSignedEntry = false;
  let seenEd25519Entry = false;
  let firstUnsigned = null;
  let firstNonEd25519 = null;

  for (const { line, lineNo } of nonEmpty) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return fail(lineNo - 1, { seq: null, lineNo, reason: 'malformed JSON' }, `chain broken at line ${lineNo}: malformed JSON`);
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail(lineNo - 1, { seq: null, lineNo, reason: 'entry must be an object' }, `chain broken at line ${lineNo}: entry must be an object`);
    }

    if (!Number.isInteger(entry.seq) || entry.seq < 1) {
      return fail(lineNo - 1, { seq: entry.seq ?? null, lineNo, reason: 'invalid seq' }, `chain broken at line ${lineNo}: seq must be a positive integer`);
    }

    const isFirst = prevRawLine === null;

    if (isFirst) {
      if (entry.prev !== null) {
        return fail(0, { seq: entry.seq, lineNo, reason: 'first entry prev must be null' }, `chain broken at seq ${entry.seq} (line ${lineNo}): first entry prev must be null`);
      }
    } else {
      const expected = sha256(prevRawLine);
      if (entry.prev !== expected) {
        return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'prev hash mismatch' }, `chain broken at seq ${entry.seq} (line ${lineNo}): prev hash mismatch`);
      }
    }

    if (isFirst) {
      if (entry.seq !== 1) {
        return fail(0, { seq: entry.seq, lineNo, reason: 'first entry seq must be 1' }, `chain broken at seq ${entry.seq} (line ${lineNo}): first entry seq must be 1`);
      }
    } else if (entry.seq !== prevSeq + 1) {
      return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'seq not contiguous' }, `chain broken at seq ${entry.seq} (line ${lineNo}): seq must be contiguous (+1 from previous)`);
    }

    const hasAnchor = Object.hasOwn(entry, 'anchor');
    if (isFirst) {
      firstAnchor = hasAnchor ? entry.anchor : undefined;
      if (anchorOnFirst && !hasAnchor) {
        return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'segment first entry missing required anchor field' }, `chain broken at seq ${entry.seq} (line ${lineNo}): segment first entry missing required anchor field`);
      }
      if (!anchorOnFirst && hasAnchor) {
        return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'root entry must not carry an anchor field' }, `chain broken at seq ${entry.seq} (line ${lineNo}): root entry must not carry an anchor field`);
      }
    } else if (hasAnchor) {
      return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'only a segment\'s first entry may carry an anchor field' }, `chain broken at seq ${entry.seq} (line ${lineNo}): only a segment's first entry may carry an anchor field`);
    }

    if (hasAnyVerifier) {
      const hasSig = entry.sig !== undefined && entry.sig !== null;
      if (entry.sigAlg === SIG_ALG_ED25519) {
        if (!hasSig) {
          return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'unsigned entry' }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`);
        }
        if (!entrySigValid(key, entry, { publicKey })) {
          return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'signature invalid' }, `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`);
        }
        seenSignedEntry = true;
        seenEd25519Entry = true;
      } else if (entry.sigAlg !== undefined) {
        return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'signature invalid' }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsupported signature algorithm`);
      } else {
        if (seenEd25519Entry) {
          return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'downgrade after ed25519 entry' }, `chain broken at seq ${entry.seq} (line ${lineNo}): non-ed25519 entry after ed25519 era`);
        }
        if (firstNonEd25519 === null) firstNonEd25519 = { seq: entry.seq, lineNo };
        if (!hasSig) {
          if (firstUnsigned === null) firstUnsigned = { seq: entry.seq, lineNo };
          if (hasHmacKey) {
            const toleratedLegacyPrefix = !requireSignatures && !seenSignedEntry;
            if (!toleratedLegacyPrefix) {
              return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'unsigned entry' }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`);
            }
          }
        } else if (hasHmacKey) {
          if (!entrySigValid(key, entry, { publicKey })) {
            return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'signature invalid' }, `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`);
          }
          seenSignedEntry = true;
        }
      }
    }

    prevRawLine = line;
    prevSeq = entry.seq;
  }

  if (requireSignatures && !hasHmacKey && hasEd25519Verifier && !allowPreEd25519Only && !seenEd25519Entry) {
    const target = firstNonEd25519 ?? { seq: null, lineNo: null };
    return fail(
      nonEmpty.length,
      { seq: target.seq, lineNo: target.lineNo, reason: 'no valid ed25519 signatures' },
      'chain broken: no valid ed25519 signatures found',
    );
  }

  const signed = requireSignatures && (hasHmacKey || (hasEd25519Verifier && seenEd25519Entry));
  return {
    valid: true,
    message: signed ? `manifest ok, signed (${nonEmpty.length} entries)` : `manifest ok (${nonEmpty.length} entries)`,
    count: nonEmpty.length,
    signed,
    break: null,
    lastRawLine: prevRawLine,
    firstAnchor,
    sawSignedEntry: seenSignedEntry,
    firstUnsigned,
    sawEd25519Entry: seenEd25519Entry,
    firstNonEd25519,
  };

  function fail(count, breakInfo, message) {
    return {
      valid: false,
      message,
      count,
      signed: false,
      break: breakInfo,
      lastRawLine: null,
      firstAnchor: undefined,
      sawSignedEntry: false,
      firstUnsigned: null,
      sawEd25519Entry: false,
      firstNonEd25519: null,
    };
  }
}

function seqMap(nonEmpty) {
  const m = new Map();
  for (const { line } of nonEmpty) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry && Number.isInteger(entry.seq)) m.set(entry.seq, line);
  }
  return m;
}

export function verifyManifestForest(dir = '.adlc', { requireSignatures = true, requireEntries = false, key = null, publicKey = undefined } = {}) {
  let effectivePublicKey = publicKey;
  if (effectivePublicKey === undefined) {
    const adminPub = readAdminPublicKey(dir);
    if (adminPub.status === 'error') {
      return {
        valid: false,
        message: `${ADMIN_PUB_FILENAME}: ${adminPub.reason}`,
        count: 0,
        segments: 0,
        signed: false,
        break: { seq: null, lineNo: null, reason: adminPub.reason, segment: ADMIN_PUB_FILENAME },
      };
    }
    effectivePublicKey = adminPub.publicKey;
  }

  const hasHmacKey = key !== null && !isEd25519PrivateKey(key);
  const hasEd25519Verifier = effectivePublicKey !== null || isEd25519PrivateKey(key);

  const rootRaw = readRawLines(join(dir, 'manifest.jsonl'));
  const { valid: segmentNames, invalid: invalidSegments } = discoverSegments(dir);

  if (invalidSegments.length > 0) {
    const first = invalidSegments[0];
    return {
      valid: false,
      message: `manifest.d/${first.name}: ${first.reason}`,
      count: 0,
      segments: segmentNames.length,
      signed: false,
      break: { seq: null, lineNo: null, reason: first.reason, segment: first.name },
    };
  }

  const markerCheck = validateForestMarker(dir);
  if (!markerCheck.ok) {
    return {
      valid: false,
      message: `manifest.d/.store.json: ${markerCheck.reason}`,
      count: 0,
      segments: segmentNames.length,
      signed: false,
      break: { seq: null, lineNo: null, reason: markerCheck.reason, segment: '.store.json' },
    };
  }

  if (segmentNames.length === 0) {
    if (requireEntries && rootRaw.length === 0) {
      const reason = 'empty manifest (--require-entries requires at least one entry)';
      return {
        valid: false,
        message: reason,
        count: 0,
        segments: 0,
        signed: false,
        break: { seq: null, lineNo: null, reason, segment: 'root' },
      };
    }
    const result = verifyChain(rootRaw, { key, publicKey: effectivePublicKey, requireSignatures, anchorOnFirst: false });
    if (isUnsignedKeyedRoot(markerCheck.auth, key, requireSignatures, result)) {
      const u = result.firstUnsigned;
      return { valid: false, message: `chain broken at seq ${u.seq} (line ${u.lineNo}): unsigned entry`, count: result.count, segments: 0, signed: false, break: { seq: u.seq, lineNo: u.lineNo, reason: 'unsigned entry', segment: 'root' } };
    }
    return { valid: result.valid, message: result.message, count: result.count, segments: 0, signed: result.signed, break: result.break ? { ...result.break, segment: 'root' } : null };
  }

  const rootResult = verifyChain(rootRaw, {
    key,
    publicKey: effectivePublicKey,
    requireSignatures,
    anchorOnFirst: false,
    allowPreEd25519Only: true,
  });
  if (!rootResult.valid) {
    return { valid: false, message: rootResult.message, count: rootResult.count, segments: segmentNames.length, signed: false, break: { ...rootResult.break, segment: 'root' } };
  }

  const chainsBySeq = new Map();
  chainsBySeq.set('root', seqMap(rootRaw));
  const anchorBySegment = new Map();
  const segmentResults = new Map();
  let totalCount = rootResult.count;
  let allSigned = rootResult.count === 0 ? true : rootResult.signed;
  let forestSawEd25519 = rootResult.sawEd25519Entry;

  for (const name of segmentNames) {
    const raw = readRawLines(segmentPath(dir, name));
    const result = verifyChain(raw, {
      key,
      publicKey: effectivePublicKey,
      requireSignatures,
      anchorOnFirst: true,
      allowPreEd25519Only: true,
    });
    if (!result.valid) {
      return { valid: false, message: `manifest.d/${name}: ${result.message}`, count: totalCount + result.count, segments: segmentNames.length, signed: false, break: { ...result.break, segment: name } };
    }
    chainsBySeq.set(name, seqMap(raw));
    anchorBySegment.set(name, result.firstAnchor === undefined ? null : result.firstAnchor);
    segmentResults.set(name, result);
    totalCount += result.count;
    allSigned = allSigned && (result.count === 0 ? true : result.signed);
    if (result.sawEd25519Entry) forestSawEd25519 = true;
  }

  for (const name of segmentNames) {
    const anchor = anchorBySegment.get(name);
    const resolved = resolveAnchor(anchor, chainsBySeq, rootResult.count > 0);
    if (!resolved.ok) {
      return { valid: false, message: `manifest.d/${name}: ${resolved.reason}`, count: totalCount, segments: segmentNames.length, signed: false, break: { seq: null, lineNo: null, reason: resolved.reason, segment: name } };
    }
  }

  const cycleCheck = detectAnchorCycle(anchorBySegment);
  if (!cycleCheck.ok) {
    return { valid: false, message: `manifest.d/${cycleCheck.segment}: anchor cycle detected`, count: totalCount, segments: segmentNames.length, signed: false, break: { seq: null, lineNo: null, reason: 'anchor cycle', segment: cycleCheck.segment } };
  }

  if (hasEd25519Verifier) {
    const edEra = checkForestEd25519Era({
      segmentNames,
      anchorBySegment,
      rootSawEd25519: rootResult.sawEd25519Entry,
      segmentResults,
    });
    if (!edEra.ok) {
      const u = edEra.firstNonEd25519;
      const msg = `chain broken at seq ${u.seq} (line ${u.lineNo}): non-ed25519 entry after ed25519 era`;
      return {
        valid: false,
        message: `manifest.d/${edEra.segment}: ${msg}`,
        count: totalCount,
        segments: segmentNames.length,
        signed: false,
        break: { seq: u.seq, lineNo: u.lineNo, reason: 'downgrade after ed25519 entry', segment: edEra.segment },
      };
    }
    if (requireSignatures && !hasHmacKey && totalCount > 0 && !forestSawEd25519) {
      return {
        valid: false,
        message: 'manifest forest has no valid ed25519 signatures',
        count: totalCount,
        segments: segmentNames.length,
        signed: false,
        break: { seq: null, lineNo: null, reason: 'no valid ed25519 signatures', segment: 'root' },
      };
    }
  }

  if (hasHmacKey && !requireSignatures) {
    const eraCheck = checkForestSignedEra({
      declaredAuth: markerCheck.auth,
      rootEmpty: rootRaw.length === 0,
      rootCutover: hasManifestCutoverTail(rootRaw),
      segmentNames,
      anchorBySegment,
      rootSawSigned: rootResult.sawSignedEntry,
      rootFirstUnsigned: rootResult.firstUnsigned,
      segmentResults,
    });
    if (!eraCheck.ok) {
      const u = eraCheck.firstUnsigned;
      const msg = `chain broken at seq ${u.seq} (line ${u.lineNo}): unsigned entry`;
      const prefix = eraCheck.segment === 'root' ? '' : `manifest.d/${eraCheck.segment}: `;
      return {
        valid: false,
        message: `${prefix}${msg}`,
        count: totalCount,
        segments: segmentNames.length,
        signed: false,
        break: { seq: u.seq, lineNo: u.lineNo, reason: 'unsigned entry', segment: eraCheck.segment },
      };
    }
  }

  const signed = hasHmacKey ? allSigned : (hasEd25519Verifier && requireSignatures && forestSawEd25519);
  return {
    valid: true,
    message: signed
      ? `manifest ok, signed (${totalCount} entries, ${segmentNames.length} segments)`
      : `manifest ok (${totalCount} entries, ${segmentNames.length} segments)`,
    count: totalCount,
    segments: segmentNames.length,
    signed,
    break: null,
  };
}

function isChainIntact(lines, key, publicKey = null) {
  return verifyChain(
    lines.map((line, i) => ({ line, lineNo: i + 1 })),
    { key, publicKey, requireSignatures: false, anchorOnFirst: true },
  ).valid;
}

export function resolveOpenSegment(dir = '.adlc', opts = {}) {
  const key = opts?.key ?? null;
  let cwd;
  ({ dir, cwd } = normalizeManifestDirAndCwd(dir, opts));
  let effectivePublicKey = opts?.publicKey;
  if (effectivePublicKey === undefined) {
    const adminPub = readAdminPublicKey(dir);
    if (adminPub.status === 'error') {
      throw new Error(`${ADMIN_PUB_FILENAME}: ${adminPub.reason}`);
    }
    effectivePublicKey = adminPub.publicKey;
  }
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
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && entrySigValid(key, first, { publicKey: effectivePublicKey });
      if (!isChainIntact(lines, key, effectivePublicKey) || !firstAuthenticated) {
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
  assertSegmentPathCommittable(dir, name, { cwd });
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  return { name, isNew: true, anchor, ...(branch !== null ? { branch } : {}) };
}
