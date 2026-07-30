// manifest-segments.mjs — segmented gate-manifest support for ticket evidence
// (T-MANIFEST-FOREST, docs/specs/segmented-gate-manifest.md).
//
// DUPLICATED, not imported, from @adlc/gate-manifest/lib/{forest,lineage}.mjs:
// @adlc/core already depends on @adlc/tickets (core/lib/tickets.mjs), and
// @adlc/gate-manifest depends on @adlc/core — so tickets -> gate-manifest
// would be a cycle (tickets -> gate-manifest -> core -> tickets). This
// mirrors the existing precedent in doctor.mjs, which already duplicates
// gate-manifest's sign.mjs byte-for-byte for the identical reason. Keep this
// file's behavior in sync with gate-manifest's forest.mjs/lineage.mjs by
// hand; there is no automated check that they agree.
//
// Scope is deliberately narrower than gate-manifest's own reader: this file
// only needs (a) "is this repo segmented", (b) "which segment does the next
// ticket-evidence append target" (using the SAME .lineage protocol and
// segment-naming grammar as gate-manifest's writer, so both producers share
// one open segment per branch instead of each minting their own), and (c) a
// full-forest entry scan for the idempotency check.
//
// *.lock handling IS content-aware, mirroring gate-manifest's own
// looksLikeGenuineLedgerLock (P5 prosecution finding): forestChainsIntact is
// now a fail-closed precondition before finalizing a ticket transaction (see
// its own doc), so a NAME-only *.lock skip would let a malicious branch
// rename a real segment — one whose chain is broken, or one this checkout's
// own idempotency scan should have seen — to end in `.lock`, silently
// vanishing it from the forest instead of being caught as bad-filename-
// grammar. Content-checking it against withManifestLock's own owner-record
// shape ({version, token, pid, hostname, startedAt} in this file's own
// withManifestLock) closes that exactly the way gate-manifest's history
// already proved necessary for the identical class of object.

import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, unlinkSync, mkdirSync, constants as fsConstants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { sha256, canonicalJson } from './canonical.mjs';

const SEGMENT_DIRNAME = 'manifest.d';
const SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
// Only `.store.json` needs an explicit reserved-name skip: `.lineage` is
// ALSO excluded, but for free, by SEGMENT_NAME_RE alone (it doesn't end in
// exactly `.jsonl`) — listing it here too would be a genuinely unobservable
// (equivalent-mutant-prone) redundancy, not a second real guard.
const RESERVED_NAMES = new Set(['.store.json']);
const MARKER_NAME = '.store.json';
const LINEAGE_NAME = '.lineage';
const MARKER_FORMAT = 'adlc-manifest-segments';
const MARKER_VERSION = 1;
const MAX_LOCAL_JSON_BYTES = 4096; // generous headroom for a marker/token; real ones are under 200 bytes
const MAX_LOCK_OWNER_BYTES = 512; // withManifestLock's owner record is ~120 bytes; generous headroom, not a real limit

// Mirrors @adlc/gate-manifest/lib/forest.mjs's looksLikeGenuineLedgerLock
// exactly (see this file's header). A genuine lock is briefly 0 bytes
// between withManifestLock's openSync('wx') and writeFileSync — size===0 is
// always treated as a genuine transient lock, never a hidden segment (an
// empty file can never hide real segment content).
function looksLikeGenuineLedgerLock(path, size) {
  if (size === 0) return true;
  if (size >= MAX_LOCK_OWNER_BYTES) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').trim());
  } catch {
    // leave parsed at its null default — falls through to the same shape
    // check below, which already rejects a non-object.
  }
  return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
    && typeof parsed.token === 'string' && typeof parsed.pid === 'number'
    && typeof parsed.hostname === 'string' && typeof parsed.startedAt === 'string';
}

function segmentDirPath(dir) {
  return join(dir, SEGMENT_DIRNAME);
}

export function segmentPath(dir, name) {
  return join(segmentDirPath(dir), name);
}

function markerPath(dir) {
  return join(segmentDirPath(dir), MARKER_NAME);
}

export function lineagePath(dir) {
  return join(segmentDirPath(dir), LINEAGE_NAME);
}

/** Real segment filenames only — structural files and anything not matching the grammar excluded. */
// Mirrors @adlc/gate-manifest/lib/forest.mjs's discoverSegments SHAPE
// ({valid, invalid}), not just its valid-name list (adversarial-review
// finding, P5 prosecution): a non-conforming filesystem object under
// manifest.d/ (a symlink, a nested directory, a non-regular file, a bad-
// grammar name) must be reported as INVALID, not silently skipped — spec
// §5 item 1 requires the whole forest to fail closed on it, and this
// package's own callers (forestChainsIntact) claim exactly that behavior
// ("mirrors gate-manifest's own segment-writer.mjs precondition"). Silently
// skipping let a directory shadow where a real segment (e.g. one holding a
// needs-attention revocation) should be, while forestChainsIntact still
// reported the forest valid. Case-collision detection and *.lock content-
// awareness are still deliberately out of scope — see this file's header.
function discoverSegments(dir) {
  const segDir = segmentDirPath(dir);
  let dirStat;
  try {
    dirStat = lstatSync(segDir); // lstatSync, never existsSync — never follow a symlinked manifest.d/
  } catch {
    return { valid: [], invalid: [] };
  }
  if (dirStat.isSymbolicLink()) return { valid: [], invalid: [{ name: '.', reason: 'manifest.d/ is a symlink' }] };
  if (!dirStat.isDirectory()) return { valid: [], invalid: [{ name: '.', reason: 'manifest.d/ is not a directory' }] };
  let names;
  try {
    names = readdirSync(segDir).sort();
  } catch (err) {
    return { valid: [], invalid: [{ name: '.', reason: `cannot read manifest.d/: ${err.message}` }] };
  }
  const valid = [];
  const invalid = [];
  for (const name of names) {
    if (RESERVED_NAMES.has(name)) continue;
    let st;
    try {
      st = lstatSync(join(segDir, name));
    } catch (err) {
      invalid.push({ name, reason: `cannot stat: ${err.message}` });
      continue;
    }
    if (st.isSymbolicLink()) { invalid.push({ name, reason: 'symlink' }); continue; }
    if (st.isDirectory()) { invalid.push({ name, reason: 'nested directory' }); continue; }
    if (!st.isFile()) { invalid.push({ name, reason: 'not a regular file' }); continue; }
    if (name === LINEAGE_NAME) continue; // never a segment by grammar alone — expected, legitimate
    if (name.endsWith('.lock')) {
      if (looksLikeGenuineLedgerLock(join(segDir, name), st.size)) continue; // a transient advisory lock, not a segment
      invalid.push({ name, reason: 'lock-suffixed object is not a genuine advisory lock' });
      continue;
    }
    if (!SEGMENT_NAME_RE.test(name)) {
      invalid.push({ name, reason: 'bad filename grammar' });
      continue;
    }
    valid.push(name);
  }
  return { valid, invalid };
}

function readRawLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function parseLines(lines) {
  return lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Manifest HMAC verification, mirroring @adlc/gate-manifest's sign.mjs
// byte-for-byte. It cannot be imported: the package graph is tickets ← core
// ← gate-manifest, so tickets (the base layer) would create a cycle. The v1
// form is a fixed key order; v2 signs canonical JSON of every field but
// `sig` (this package's canonicalJson is byte-identical to core's, verified
// by test). Keep in lockstep with sign.mjs. Shared by doctor.mjs and the
// signature-aware chain check below — the one place both need it.
//
// No ambient env read lives here (manifest-key-hermeticity, T2/#410): every
// caller in this package now receives its signing key as an explicit
// parameter, resolved once by the entry point (a bin) — see key-contract.mjs.

export function canonicalEntryBytes(entry) {
  if (entry.sigVersion === 2) {
    const { sig: _sig, ...signed } = entry;
    return canonicalJson(signed);
  }
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== undefined) canonical.ticket = entry.ticket;
  if (entry.data !== undefined) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return JSON.stringify(canonical);
}

export function entrySigValid(key, entry) {
  if (typeof entry.sig !== 'string' || entry.sig.length === 0) return false;
  const expected = createHmac('sha256', key).update(canonicalEntryBytes(entry)).digest('hex');
  const a = Buffer.from(entry.sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Chain integrity: each entry's `prev` must equal sha256(previous raw line)
// and `seq` must increase by 1 from 1. Mirrors the chain half of
// @adlc/gate-manifest/lib/verify.mjs's verifyChain — no anchor/cycle
// resolution (out of scope here, see manifest-segments.mjs's header).
//
// SIGNATURE (adversarial-review finding): when `key` is provided, also
// enforce verifyChain's "requireSignatures:false" signed-continuity rule —
// once this ONE chain has a validly-signed entry, every LATER entry in it
// must also carry a valid signature (a present-but-invalid signature always
// fails, everywhere). Evaluated PER CHAIN, matching gate-manifest's own
// per-chain `seenSignedEntry` semantics. Without this, an attacker could
// append a correctly hash-chained but UNSIGNED forged entry (matching a real
// transactionId/action) and the idempotency scan in evidence.mjs would trust
// it as genuine, even with a signing key configured. `key === null` keeps
// the original chain-only check (no key means nothing can be verified;
// matches segment-writer.mjs's own precondition).
function chainIsIntact(lines, key = null) {
  let prevLine = null;
  let prevSeq = 0;
  let seenSignedEntry = false;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { return false; }
    const expectedPrev = prevLine === null ? null : sha256(prevLine);
    if (entry?.prev !== expectedPrev || entry?.seq !== prevSeq + 1) return false;
    if (key !== null) {
      const hasSig = typeof entry?.sig === 'string' && entry.sig.length > 0;
      if (hasSig) {
        if (!entrySigValid(key, entry)) return false;
        seenSignedEntry = true;
      } else if (seenSignedEntry) {
        return false; // missing sig after this chain's signed era began
      }
    }
    prevLine = line;
    prevSeq = entry.seq;
  }
  return true;
}

/**
 * True iff root's chain AND every discovered segment's chain are each
 * internally intact (adversarial-review finding: a corrupted OTHER segment
 * must block a ticket evidence append the same way gate-manifest's own
 * segment-writer.mjs refuses to append onto a forest it hasn't confirmed is
 * valid — a ticket transaction must not finalize, and delete its recovery
 * journal, against evidence that lands in an already-broken forest).
 * `key`, when provided, also enforces per-chain signature validity — see
 * chainIsIntact's doc.
 */
export function forestChainsIntact(dir, { key = null } = {}) {
  if (!chainIsIntact(readRawLines(join(dir, 'manifest.jsonl')), key)) return false;
  const { valid, invalid } = discoverSegments(dir);
  if (invalid.length > 0) return false; // a non-conforming object anywhere invalidates the whole forest
  return valid.every((name) => chainIsIntact(readRawLines(segmentPath(dir, name)), key));
}

/**
 * Every entry from root plus every segment, in file-discovery order (not the
 * anchor-depth ordering gate-manifest's own reader uses for display — order
 * does not matter for "does an entry with this transactionId exist
 * anywhere", the only thing this is used for).
 */
export function readForestEntries(dir) {
  const root = parseLines(readRawLines(join(dir, 'manifest.jsonl')));
  const segments = discoverSegments(dir).valid.flatMap((name) => parseLines(readRawLines(segmentPath(dir, name))));
  return [...root, ...segments];
}

/**
 * Root's chain, followed by THIS branch's own open segment's chain (if one is
 * already open) — never any OTHER lineage's segment. Returned as SEPARATE
 * chains (not flattened) because `seq` is only meaningful WITHIN a chain:
 * each chain restarts at 1, so a caller cannot compare `seq` across the
 * returned arrays to find "the latest entry" — it must treat a LATER chain
 * (by return-array position) as strictly newer than an EARLIER one
 * regardless of the seq values inside it, and only compare `seq` for two
 * entries already known to be from the SAME chain (adversarial-review
 * finding: a stale root entry with a high seq must never outrank a
 * causally-later segment entry with a low one). Matches the existing
 * root+own-segment scoping used by storeHashBindingCheck and
 * carryForwardCrossModelReview — no total order exists across UNRELATED
 * segments, so this deliberately never reads them.
 */
export function readOwnChains(dir, { cwd = dirname(dir) } = {}) {
  const root = parseLines(readRawLines(join(dir, 'manifest.jsonl')));
  if (!isSegmentedRepo(dir)) return [root];
  const peeked = peekOpenSegment(dir, { cwd });
  if (!peeked) return [root];
  return [root, parseLines(readRawLines(segmentPath(dir, peeked.name)))];
}

// SECURITY: `.store.json` is repository-TRACKED, so a malicious branch can
// commit it as a symlink to an unbounded source (e.g. a character device) —
// isSegmentedRepo runs on every ticket evidence append. O_NOFOLLOW (never
// follows a symlink) plus a hard byte cap (real markers/tokens are under 200
// bytes) closes both the symlink-follow and unbounded-read paths. Mirrors
// gate-manifest/lib/lineage.mjs's readBoundedJsonNoFollow exactly.
function readBoundedJsonNoFollow(path) {
  // lstatSync FIRST, not just O_NOFOLLOW on the open (cross-platform finding,
  // mirrors @adlc/gate-manifest/lib/lineage.mjs's identical fix): O_NOFOLLOW's
  // enforcement is not portable — Windows CI showed a symlinked marker was
  // silently followed, since O_NOFOLLOW is not reliably honored there (Windows
  // symlinks are reparse points, handled differently than POSIX symlinks by
  // Node's fs layer). lstatSync + isFile() is a portable, OS-independent
  // check; O_NOFOLLOW stays for its atomicity where it IS honored.
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null; // a symlink, directory, or other non-regular object — never followed
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

function hasActivationMarker(dir) {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === 'object'
    && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}

function rootEndsInCutover(dir) {
  const raw = readRawLines(join(dir, 'manifest.jsonl'));
  if (raw.length === 0) return false;
  try {
    const last = JSON.parse(raw.at(-1));
    return Boolean(last) && typeof last === 'object' && last.gate === 'manifest-cutover';
  } catch {
    return false;
  }
}

/** Spec §4.7 — mirrors @adlc/gate-manifest/lib/lineage.mjs's isSegmentedRepo exactly. */
export function isSegmentedRepo(dir) {
  return hasActivationMarker(dir) || rootEndsInCutover(dir);
}

// Crockford base32, mirrors @adlc/gate-manifest/lib/lineage.mjs's ULID
// encoder (itself mirroring @adlc/tickets/lib/ids.mjs's ticket-ULID encoder)
// byte-for-byte.
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function encodeUlidPart(value, width) {
  let remaining = BigInt(value);
  let output = '';
  for (let i = 0; i < width; i += 1) {
    output = ULID_ALPHABET[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}
function generateSegmentUlid(now = Date.now(), entropy = randomBytes(10)) {
  const random = BigInt(`0x${entropy.toString('hex')}`);
  return `${encodeUlidPart(BigInt(now), 10)}${encodeUlidPart(random, 16)}`;
}

// spec §7.1 slug derivation — mirrors gate-manifest/lib/lineage.mjs's deriveSlug exactly.
function deriveSlug(branchName) {
  const lowered = String(branchName ?? '').toLowerCase();
  const substituted = lowered.replace(/[^a-z0-9-]+/g, '-');
  const collapsed = substituted.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const truncated = collapsed.slice(0, 40).replace(/-+$/g, '');
  return truncated || 'segment';
}

function currentBranch(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' || out === 'HEAD' ? null : out; // detached HEAD never matches a cached token
  } catch {
    return null;
  }
}

function readLineageToken(dir) {
  const token = readBoundedJsonNoFollow(lineagePath(dir));
  if (!token || typeof token !== 'object') return null;
  if (typeof token.segment !== 'string' || typeof token.ulid !== 'string' || typeof token.branch !== 'string') return null;
  return token;
}

function isSymlinkOrOtherNonRegular(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return false;
  }
  return !st.isFile();
}

// SECURITY: never write through a symlink planted at .lineage — see
// gate-manifest/lib/lineage.mjs's identical writeLineageToken for the full
// rationale (a written token embeds the branch name, and branch names can
// contain shell metacharacters, making a followed symlink a near-RCE
// primitive).
function writeLineageToken(dir, token) {
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

// spec §4.2: ULID is the last 26 chars before `.jsonl`.
function ulidOf(segmentName) {
  return segmentName.slice(segmentName.length - '.jsonl'.length - 26, segmentName.length - '.jsonl'.length);
}

/**
 * Read-only lookup of the current lineage's ALREADY-OPEN segment, if one
 * exists — never mints, never writes .lineage. Returns null when there is no
 * usable existing segment (the next real append would have to mint one).
 *
 * Exists for callers that need to know "what will THIS append target"
 * *before* actually appending, without racing the real writer: minting has a
 * side effect (writing a fresh .lineage token) that does not yet correspond
 * to any file on disk, so calling the full resolveOpenSegment twice before a
 * real append happens can make each call mint a DIFFERENT segment (the
 * second call's token check fails because the first mint's file was never
 * created). A caller that only needs "is there already an open one" is safe
 * to call this before the real write; one that needs the eventual path when
 * a fresh mint is possible must re-resolve with resolveOpenSegment AFTER the
 * real write completes, once the file genuinely exists.
 */
export function peekOpenSegment(dir, { cwd = dirname(dir) } = {}) {
  const branch = currentBranch(cwd);
  const token = readLineageToken(dir);
  if (branch !== null && token && token.branch === branch) {
    if (discoverSegments(dir).valid.includes(token.segment) && ulidOf(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }
  return null;
}

/**
 * Resolve which segment the next ticket-evidence append should target,
 * mirroring @adlc/gate-manifest/lib/lineage.mjs's resolveOpenSegment (spec
 * §7.1) so both producers share the SAME open segment for one branch rather
 * than each minting their own.
 *
 * @returns {{ name: string, isNew: boolean, anchor?: object|null }}
 */
export function resolveOpenSegment(dir, { cwd = dirname(dir) } = {}) {
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;
  const branch = currentBranch(cwd);
  const rootLines = readRawLines(join(dir, 'manifest.jsonl'));
  const rootLast = rootLines.at(-1) ?? null;
  let anchor = null;
  if (rootLast !== null) {
    let lastEntry = null;
    try { lastEntry = JSON.parse(rootLast); } catch { /* leave anchor null; caller's own append will surface the malformed root */ }
    if (lastEntry) anchor = { segment: 'root', seq: lastEntry.seq, lineHash: sha256(rootLast) };
  }
  const ulid = generateSegmentUlid();
  const slug = deriveSlug(branch ?? '');
  const name = `${slug}-${ulid}.jsonl`;
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  return { name, isNew: true, anchor };
}
