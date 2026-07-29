// lineage.mjs — segmented-repo detection and lineage-token resolution for the
// writer (T-MANIFEST-FOREST slice 3, docs/specs/segmented-gate-manifest.md §4.7/§7.1).
//
// Split from segment-writer.mjs (which owns the actual locked append) because
// this half is pure decision-making: "is this repo segmented" and "which
// segment file should the NEXT append target". Neither question touches the
// ledger lock.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { git, sha256, ledgerPath, ADLC_DIR } from '@adlc/core';
import { segmentDirPath, discoverSegments, readRawLines, ulidOf } from './forest.mjs';

const MARKER_NAME = '.store.json';
const LINEAGE_NAME = '.lineage';
const MARKER_FORMAT = 'adlc-manifest-segments';

export function markerPath(dir) {
  return join(segmentDirPath(dir), MARKER_NAME);
}

export function lineagePath(dir) {
  return join(segmentDirPath(dir), LINEAGE_NAME);
}

function hasActivationMarker(dir) {
  const p = markerPath(dir);
  if (!existsSync(p)) return false;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Boolean(parsed) && typeof parsed === 'object' && parsed.format === MARKER_FORMAT;
  } catch {
    return false; // a corrupted marker is not a valid marker — fall through to the cutover-entry test
  }
}

function rootEndsInCutover(dir) {
  const raw = readRawLines(ledgerPath('manifest', dir));
  if (raw.length === 0) return false;
  try {
    const last = JSON.parse(raw.at(-1).line);
    return Boolean(last) && typeof last === 'object' && last.gate === 'manifest-cutover';
  } catch {
    return false; // malformed tail — verify() will fail this loudly elsewhere; not this predicate's job
  }
}

/**
 * Spec §4.7: a repo is segmented when the activation marker exists OR root's
 * last entry is the cutover entry — checked BOTH ways so losing one marker
 * (e.g. an operator deletes manifest.d/.store.json by hand) does not un-freeze
 * root. Readers never consult this; only the writer does.
 */
export function isSegmentedRepo(dir = ADLC_DIR) {
  return hasActivationMarker(dir) || rootEndsInCutover(dir);
}

// Crockford base32, mirrors packages/tickets/lib/ids.mjs's ticket-ULID encoder
// byte-for-byte (not imported: gate-manifest depends on nothing but
// @adlc/core, and a bare 26-char segment ULID is a different value shape than
// a `T-`-prefixed ticket id, so duplicating this ~15-line encoder is cheaper
// than adding a cross-package dependency for it).
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

/** A bare 26-char uppercase Crockford-base32 ULID (spec §4.2) — no prefix. */
export function generateSegmentUlid(now = Date.now(), entropy = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new RangeError('ULID timestamp out of range');
  if (!Buffer.isBuffer(entropy) || entropy.length !== 10) throw new TypeError('ULID entropy must be 10 bytes');
  const random = BigInt(`0x${entropy.toString('hex')}`);
  return `${encodeUlidPart(BigInt(now), 10)}${encodeUlidPart(random, 16)}`;
}

// spec §7.1: "slug is 1-40 chars of [a-z0-9-] derived from the creating
// branch name (non-conforming chars dropped, lowercased, collapsed; `segment`
// when derivation yields nothing)". Each run of non-conforming characters
// becomes a single `-` rather than vanishing outright — a literal drop would
// merge adjacent words together (`feat/cool` -> `featcool`), which is worse
// as a filename component than the standard slugify behavior this produces
// (`feat-cool`); "collapsed" then guards against a run of dashes this
// substitution (or an original run of real dashes) could otherwise leave.
export function deriveSlug(branchName) {
  const lowered = String(branchName ?? '').toLowerCase();
  const substituted = lowered.replace(/[^a-z0-9-]+/g, '-');
  const collapsed = substituted.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const truncated = collapsed.slice(0, 40).replace(/-+$/g, '');
  return truncated || 'segment';
}

/**
 * The current Git branch, or `null` for detached HEAD / no-repo — spec §7.1:
 * "detached HEAD never matches" a cached lineage token. `null` is also the
 * signal not to persist a new token (a token naming a branch we can't
 * identify would never match anything again anyway).
 */
export function currentBranch(cwd = process.cwd()) {
  try {
    const out = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' || out === 'HEAD' ? null : out;
  } catch {
    return null;
  }
}

function readLineageToken(dir) {
  const p = lineagePath(dir);
  if (!existsSync(p)) return null;
  try {
    const token = JSON.parse(readFileSync(p, 'utf8'));
    if (!token || typeof token !== 'object') return null;
    if (typeof token.segment !== 'string' || typeof token.ulid !== 'string' || typeof token.branch !== 'string') return null;
    return token;
  } catch {
    return null; // a corrupted local token blocks nothing — mint a fresh segment instead
  }
}

function writeLineageToken(dir, token) {
  mkdirSync(segmentDirPath(dir), { recursive: true });
  writeFileSync(lineagePath(dir), JSON.stringify(token));
}

/**
 * Resolve which segment file the NEXT append should target (spec §7.1).
 *
 * @returns {{ name: string, isNew: boolean, anchor?: object|null }}
 *   `isNew: true` means this append is the segment's FIRST entry and must
 *   carry `anchor` (also returned); `isNew: false` means append as a plain
 *   continuation of the named, already-open segment.
 */
export function resolveOpenSegment(dir = ADLC_DIR, { cwd = process.cwd() } = {}) {
  const branch = currentBranch(cwd);
  const token = readLineageToken(dir);
  if (branch !== null && token && token.branch === branch) {
    const { valid } = discoverSegments(dir);
    if (valid.includes(token.segment) && ulidOf(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }

  // No usable token: mint a new segment, anchored to root's current head line
  // if a root exists, else anchor: null (spec §4.4/§7.1 — never chase the
  // stale token's segment or any other segment as a fallback anchor target).
  const rootLines = readRawLines(ledgerPath('manifest', dir));
  const rootLast = rootLines.at(-1) ?? null;
  let anchor = null;
  if (rootLast !== null) {
    const lastEntry = JSON.parse(rootLast.line);
    anchor = { segment: 'root', seq: lastEntry.seq, lineHash: sha256(rootLast.line) };
  }
  const ulid = generateSegmentUlid();
  const slug = deriveSlug(branch ?? '');
  const name = `${slug}-${ulid}.jsonl`;
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  return { name, isNew: true, anchor };
}
