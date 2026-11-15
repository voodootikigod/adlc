// forest.mjs — segment discovery, fork-anchor resolution, and cycle detection
// for the segmented gate-manifest (ADR-0015 / docs/specs/segmented-gate-manifest.md).
//
// packages/core is frozen (CONVENTIONS.md #2: never edit it), so the forest-aware
// machinery lives here in gate-manifest rather than in core's readEntries/ledgerPath.
// verify.mjs orchestrates a whole-forest verification using the primitives below;
// record.mjs (writer, a later slice) will use discoverSegments + segmentPath for
// lineage routing.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { sha256, ledgerPath, ADLC_DIR } from '@adlc/core';
import {
  SEGMENT_DIRNAME,
  MARKER_FORMAT,
  MARKER_VERSION,
  segmentDirPath,
  segmentPath,
  discoverSegments,
  ulidOf,
  looksLikeGenuineLedgerLock,
  markerPath,
  readBoundedJsonNoFollow,
} from '@adlc/tickets/lib/manifest-primitives.mjs';

export {
  SEGMENT_DIRNAME,
  segmentDirPath,
  segmentPath,
  discoverSegments,
  ulidOf,
  looksLikeGenuineLedgerLock,
};

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

  const anchorMap = new Map();
  for (const [name, info] of bySegment.entries()) anchorMap.set(name, info.anchor);
  const orderedNames = orderSegmentNames(segmentNames, anchorMap);

  const entries = [...root.entries];
  for (const name of orderedNames) entries.push(...bySegment.get(name).entries);

  return { entries, skipped };
}

/**
 * Deterministically order segment names so every parent precedes its anchored
 * children, breaking ties by (anchor.segment, anchor.seq, ULID, filename).
 *
 * @param {string[]} segmentNames
 * @param {Map<string, object|null>} anchorBySegment
 * @returns {string[]}
 */
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

/**
 * Validate `.adlc/manifest.d/.store.json` fail-closed when present on disk:
 * symlinks, non-regular files, oversized (`>= 4096` bytes) or malformed JSON,
 * wrong format/version, or an unrecognized `auth` mode are rejected rather
 * than silently degrading to `auth: null`.
 *
 * @param {string} [dir]
 * @returns {{ok: true, auth: 'keyed'|'keyless'|null} | {ok: false, reason: string}}
 */
export function validateForestMarker(dir = ADLC_DIR) {
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

/**
 * True when the non-empty root chain's final raw line has `gate: "manifest-cutover"`
 * (spec §4.7's second segmentation marker alongside `.store.json`).
 */
export function hasManifestCutoverTail(rootRaw) {
  if (!Array.isArray(rootRaw) || rootRaw.length === 0) return false;
  try {
    const last = JSON.parse(rootRaw.at(-1).line);
    return Boolean(last) && typeof last === 'object' && last.gate === 'manifest-cutover';
  } catch {
    return false;
  }
}

/**
 * Enforce monotonic signed-era inheritance across segments under
 * `requireSignatures: false` when a signing key is present:
 *  - a forest explicitly activated with `auth: "keyed"` (or whose root ends in
 *    a signed `manifest-cutover` entry when `.store.json` carries no explicit
 *    auth mode, or a greenfield signed forest whose `.store.json` was deleted)
 *    requires every segment in `manifest.d/` to be signed and rejects a
 *    non-empty, 100%-unsigned root chain;
 *  - in pre-policy (`auth` absent, non-cutover) or `auth: "keyless"` forests,
 *    independent segments (`anchor: null` or anchored to `root`) evaluate
 *    signature transitions per segment per spec §4.7/§5.3/§6 (consumers that
 *    rely on approvals such as `hasCrossModelApprove` and
 *    `carryForwardCrossModelReview` independently verify `verifyEntrySignature`
 *    on every `approve` entry, while `buildAttest` labels mixed chains
 *    `partially-signed`), and any child segment anchored to a signed-era
 *    parent segment inherits the signed era transitively.
 */
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

/**
 * Reject a non-empty, 100%-unsigned root chain when `.store.json` explicitly
 * declares `auth: "keyed"` under lenient verification with a key present.
 * Preserves migrated legacy-prefix roots because `migrate` appends a signed
 * `manifest-cutover` entry (`rootResult.sawSignedEntry === true`).
 */
export function isUnsignedKeyedRoot(declaredAuth, key, requireSignatures, rootResult) {
  return (
    key !== null &&
    !requireSignatures &&
    declaredAuth === 'keyed' &&
    rootResult.valid &&
    rootResult.count > 0 &&
    !rootResult.sawSignedEntry &&
    rootResult.firstUnsigned !== null
  );
}
