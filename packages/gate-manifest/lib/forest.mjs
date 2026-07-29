// forest.mjs — segment discovery, fork-anchor resolution, and cycle detection
// for the segmented gate-manifest (ADR-0015 / docs/specs/segmented-gate-manifest.md).
//
// packages/core is frozen (CONVENTIONS.md #2: never edit it), so the forest-aware
// machinery lives here in gate-manifest rather than in core's readEntries/ledgerPath.
// verify.mjs orchestrates a whole-forest verification using the primitives below;
// record.mjs (writer, a later slice) will use discoverSegments + segmentPath for
// lineage routing.

import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, ledgerPath, ADLC_DIR } from '@adlc/core';

export const SEGMENT_DIRNAME = 'manifest.d';
// spec §4.2: <slug>-<ULID>.jsonl — slug is 1-40 chars of [a-z0-9-]; ULID is the
// 26-char UPPERCASE Crockford-base32 alphabet (no I, L, O, U), generated at
// segment creation. Grammar validation must NOT fold case (folding would defeat
// the case-collision check below), so a lowercase/mixed-case ULID is a distinct
// bad-filename-grammar rejection, not a normalized match.
const SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
// .store.json and .lineage are structural files under manifest.d/, not segments
// (spec §4.7); grammar checks skip exactly these two names.
const RESERVED_NAMES = new Set(['.store.json', '.lineage']);

// A `*.lock` name is ALSO skippable, not reported invalid — but ONLY when its
// content genuinely looks like `withLedgerLock`'s own owner record
// (T-MANIFEST-FOREST slice 3, the writer, names its advisory lock
// `<segment>.jsonl.lock`, which does not match SEGMENT_NAME_RE since it does
// not end in exactly `.jsonl`). A NAME-ONLY skip was tried first and reverted
// (adversarial-review finding): it let a malicious branch rename a real
// segment — one holding a needs-attention revocation, say — to end in
// `.lock`, silently vanishing it from the forest entirely instead of being
// caught as bad-filename-grammar, undetectably resurrecting a revoked
// approve. Requiring the CONTENT to match the lock's own narrow, distinctive
// shape closes that: a renamed segment's real JSONL content will never match
// it, so it falls through to the ordinary bad-filename-grammar rejection
// below instead of disappearing.
const LOCK_SUFFIX = '.lock';
const MAX_LOCK_OWNER_BYTES = 512; // withLedgerLock's owner record is ~120 bytes; generous headroom, not a real limit
function looksLikeGenuineLedgerLock(path, size) {
  // withLedgerLock creates the lock file (openSync(..., 'wx')) and writes its
  // owner JSON (writeFileSync) as two SEPARATE syscalls — a genuine lock is
  // briefly 0 bytes between them (adversarial-review finding). Treating an
  // empty file as "not a genuine lock" would fail the whole forest for
  // anyone whose read lands in that split-second window, exactly the
  // false-positive the earlier NAME-only skip was trying to avoid — just via
  // a different mechanism. Safe to special-case: an EMPTY file can never
  // hide a real segment's content (that requires actual bytes), so treating
  // empty as "transient, skip it" reopens no part of that earlier hole.
  if (size === 0) return true;
  if (size >= MAX_LOCK_OWNER_BYTES) return false; // real locks are tiny; at/over the cap is refused, not guessed at (same convention as lineage.mjs's bounded reads)
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').trim());
  } catch {
    // leave parsed at its null default — falls through to the same shape
    // check below, which already rejects a non-object just as unparseable
    // content should be rejected. A dedicated `return false` here would be
    // an equivalent mutant magnet (false and null are identically falsy to
    // every caller, which only ever checks truthiness) for no benefit.
  }
  return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
    && typeof parsed.token === 'string' && typeof parsed.pid === 'number'
    && typeof parsed.hostname === 'string' && typeof parsed.startedAt === 'string';
}

export function segmentDirPath(dir) {
  return join(dir, SEGMENT_DIRNAME);
}

export function segmentPath(dir, name) {
  return join(segmentDirPath(dir), name);
}

/**
 * Discover segment files under `<dir>/manifest.d/`.
 *
 * @param {string} dir  ledger directory (e.g. `.adlc`)
 * @returns {{ valid: string[], invalid: {name: string, reason: string}[] }}
 *   `valid` is sorted by filename. `invalid` names every filesystem object
 *   under manifest.d/ that fails §4.2/§5.1's grammar, type, or collision
 *   rules — reported, never silently skipped.
 */
export function discoverSegments(dir) {
  const segDir = segmentDirPath(dir);
  // lstatSync FIRST, never existsSync: existsSync follows symlinks, so a
  // DANGLING symlink at manifest.d/ (pointing at a target that doesn't
  // currently exist) makes existsSync return false and skip the symlink
  // check entirely — the exact case this check exists for.
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
  const seenLower = new Map(); // lowercased name -> first name seen with that casing

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
      if (looksLikeGenuineLedgerLock(full, st.size)) continue; // a transient advisory lock, not a segment
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

/**
 * Read a ledger file's raw lines, keeping 1-based line numbers and skipping
 * blank lines — the same shape `verify.mjs`'s single-chain walk has always
 * used, extracted so it can be applied to the root OR any segment.
 *
 * @param {string} filePath
 * @returns {{line: string, lineNo: number}[]}
 */
export function readRawLines(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .map((line, i) => ({ line, lineNo: i + 1 }))
    .filter(({ line }) => line.trim() !== '');
}

/**
 * Resolve one segment's fork anchor against the already-verified forest chains.
 *
 * @param {object} anchor  the first entry's `anchor` field — `null`, or
 *   `{segment, seq, lineHash}`
 * @param {Map<string, Map<number, string>>} chainsBySeq  segment name (or
 *   `'root'`) -> Map of seq -> that entry's exact raw line bytes, for every
 *   chain in the forest (already internally chain-verified)
 * @param {boolean} rootExists  true when the root segment has at least one
 *   entry. §4.4: `anchor: null` is permitted only while root-less; once a
 *   root exists every new segment MUST anchor to it.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
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

/**
 * Reject anchor cycles: the anchor graph MUST be a forest of trees rooted in
 * the root segment or in `anchor: null` segments (spec §5.5).
 *
 * @param {Map<string, object|null>} anchorBySegment  segment name -> its
 *   first entry's anchor (`{segment, seq, lineHash}` or `null`); root is
 *   implicitly always a valid terminus and is not a key of this map.
 * @returns {{ok: true} | {ok: false, segment: string}}  the segment where a
 *   cycle was first detected, if any
 */
export function detectAnchorCycle(anchorBySegment) {
  const state = new Map(); // segment -> 'visiting' | 'done'
  for (const start of anchorBySegment.keys()) {
    if (state.get(start) === 'done') continue;
    const path = [];
    let current = start;
    while (current !== undefined) {
      if (state.get(current) === 'visiting') return { ok: false, segment: current };
      if (state.get(current) === 'done') break;
      if (!anchorBySegment.has(current)) break; // reached 'root' or an unrecognized terminus
      state.set(current, 'visiting');
      path.push(current);
      const anchor = anchorBySegment.get(current);
      current = anchor === null ? undefined : anchor.segment;
    }
    for (const seg of path) state.set(seg, 'done');
  }
  return { ok: true };
}

function parseLenient(rawLines, segmentLabel) {
  const entries = [];
  const skipped = [];
  for (const { line, lineNo } of rawLines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      skipped.push({ segment: segmentLabel, line: lineNo, error: String(err.message ?? err) });
      continue;
    }
    // Valid JSON but not an entry object (null, a number, a string, a bare
    // array, ...): spreading a non-object is a silent no-op (`{...null}` is
    // `{}`) and spreading an array copies its indices, either way producing
    // a phantom `{segment: ...}` entry with none of its real fields — report
    // it as skipped instead of handing consumers a fabricated entry.
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped.push({ segment: segmentLabel, line: lineNo, error: 'entry must be an object' });
      continue;
    }
    entries.push({ ...entry, segment: segmentLabel });
  }
  return { entries, skipped };
}

// spec §4.2: ULID is the last 26 chars before `.jsonl`. Exported so the
// writer (lineage.mjs, T-MANIFEST-FOREST slice 3) can confirm a `.lineage`
// token's cached ULID still matches the segment file it names, without
// re-deriving the slicing logic.
export function ulidOf(segmentName) {
  return segmentName.slice(segmentName.length - '.jsonl'.length - 26, segmentName.length - '.jsonl'.length);
}

/**
 * The `readEntries('manifest')`-equivalent forest read (spec §6): every entry
 * from the root plus every valid segment, each annotated with its source
 * `segment` ('root' or the segment filename), in the SAME deterministic order
 * `show`/`attest` display — root first, then segments ordered by
 * (anchored-to segment, anchored-to seq, own ULID), entries in per-segment
 * order. That ordering is what keeps every existing "latest entry wins"
 * consumer (runner's `.at(-1)` P5-completion lookup, `show`/`attest`)
 * meaningful once entries can come from more than one chain — `ts` is
 * explicitly not a substitute (§6: display-only, never a trust decision).
 *
 * This is a LENIENT read, matching today's `readEntries`: a malformed line
 * anywhere is skipped (never silently dropped — see `skipped`) rather than
 * failing the whole read. Trust/tamper decisions belong to `verify()`, run
 * separately by the caller; this function does not itself validate chains,
 * anchors, or signatures.
 *
 * @param {string} [dir]  ledger directory (default ADLC_DIR)
 * @returns {{entries: object[], skipped: object[]}}
 */
export function readManifestForest(dir = ADLC_DIR) {
  const rootRaw = readRawLines(ledgerPath('manifest', dir));
  const root = parseLenient(rootRaw, 'root');

  const { valid: segmentNames, invalid: invalidSegments } = discoverSegments(dir);
  const skipped = [...root.skipped, ...invalidSegments.map((i) => ({ segment: i.name, line: null, error: i.reason }))];

  const bySegment = new Map(); // name -> { entries, anchor }
  for (const name of segmentNames) {
    const raw = readRawLines(segmentPath(dir, name));
    const parsed = parseLenient(raw, name);
    skipped.push(...parsed.skipped);
    const anchor = parsed.entries.length > 0 && Object.hasOwn(parsed.entries[0], 'anchor') ? parsed.entries[0].anchor : null;
    bySegment.set(name, { entries: parsed.entries, anchor });
  }

  // Depth from root/null (0), walking anchor.segment links. Today's writer
  // (§7.1) only ever anchors to root or null, so every segment is depth 0 in
  // practice — but the format (§4.4) also allows anchoring to another
  // segment (repair-chain, §10, may produce this), and the (anchored-to
  // segment, anchored-to seq, ULID) sort key alone would then sort a child
  // BEFORE its parent whenever the parent's name string-sorts after the
  // child's (e.g. parent 'root' vs a lowercase-named parent segment).
  // Sorting by depth first guarantees a parent always precedes any segment
  // anchored to it, transitively; the spec's 3-key tuple then breaks ties
  // among segments at the same depth.
  const depthCache = new Map();
  function depthOf(name, seen = new Set()) {
    if (depthCache.has(name)) return depthCache.get(name);
    if (seen.has(name)) return 0; // cycle — verify() rejects this forest; don't hang here
    seen.add(name);
    const anchor = bySegment.get(name)?.anchor;
    const target = anchor?.segment;
    const depth = target && target !== 'root' && bySegment.has(target) ? depthOf(target, seen) + 1 : 0;
    depthCache.set(name, depth);
    return depth;
  }

  const orderedNames = [...segmentNames].sort((a, b) => {
    const depthDiff = depthOf(a) - depthOf(b);
    if (depthDiff !== 0) return depthDiff;
    const aa = bySegment.get(a).anchor;
    const bb = bySegment.get(b).anchor;
    const aSeg = aa?.segment ?? '';
    const bSeg = bb?.segment ?? '';
    if (aSeg !== bSeg) return aSeg < bSeg ? -1 : 1;
    const aSeq = aa?.seq ?? 0;
    const bSeq = bb?.seq ?? 0;
    if (aSeq !== bSeq) return aSeq - bSeq;
    const aUlid = ulidOf(a);
    const bUlid = ulidOf(b);
    if (aUlid !== bUlid) return aUlid < bUlid ? -1 : 1;
    // Two different segments (different slugs) sharing a ULID is a
    // near-impossible collision, not something §4.2 forbids outright — fall
    // back to the full filename so the comparator is still total (a name
    // never ties with a DIFFERENT name here, since discoverSegments already
    // rejects same-name-different-case duplicates).
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const entries = [...root.entries];
  for (const name of orderedNames) entries.push(...bySegment.get(name).entries);

  return { entries, skipped };
}
