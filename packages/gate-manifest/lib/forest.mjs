// forest.mjs — segment discovery, fork-anchor resolution, and cycle detection
// for the segmented gate-manifest (ADR-0015 / docs/specs/segmented-gate-manifest.md).
//
// packages/core is frozen (CONVENTIONS.md #2: never edit it), so the forest-aware
// machinery lives here in gate-manifest rather than in core's readEntries/ledgerPath.
// verify.mjs orchestrates a whole-forest verification using the primitives below;
// record.mjs (writer, a later slice) will use discoverSegments + segmentPath for
// lineage routing.

import { ledgerPath, ADLC_DIR } from '@adlc/core';
import {
  SEGMENT_DIRNAME,
  segmentDirPath,
  segmentPath,
  discoverSegments,
  ulidOf,
  looksLikeGenuineLedgerLock,
  readRawLines,
  resolveAnchor,
  detectAnchorCycle,
  orderSegmentNames,
  validateForestMarker,
  hasManifestCutoverTail,
  checkForestSignedEra,
  isUnsignedKeyedRoot,
} from '@adlc/tickets/lib/manifest-primitives.mjs';

export {
  SEGMENT_DIRNAME,
  segmentDirPath,
  segmentPath,
  discoverSegments,
  ulidOf,
  looksLikeGenuineLedgerLock,
  readRawLines,
  resolveAnchor,
  detectAnchorCycle,
  orderSegmentNames,
  validateForestMarker,
  hasManifestCutoverTail,
  checkForestSignedEra,
  isUnsignedKeyedRoot,
};

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
 * `segment` ('root' or the segment filename), in deterministic order.
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
