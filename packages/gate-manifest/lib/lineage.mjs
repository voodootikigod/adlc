// lineage.mjs — segmented-repo detection and lineage-token resolution for the
// writer (T-MANIFEST-FOREST slice 3, docs/specs/segmented-gate-manifest.md §4.7/§7.1).
//
// Shared primitives are single-sourced in @adlc/tickets/lib/manifest-primitives.mjs
// and re-exported here for compatibility across @adlc/gate-manifest consumers.

export {
  markerPath,
  lineagePath,
  readBoundedJsonNoFollow,
  isSegmentedRepo,
  generateSegmentUlid,
  deriveSlug,
  currentBranch,
  readLineageToken,
  writeLineageToken,
  peekOpenSegment,
  recoverOpenSegment,
  resolveOpenSegment,
  assertSegmentPathCommittable,
  firstEntryOf,
  encodeUlidPart,
  hasActivationMarker,
  rootEndsInCutover,
  isSymlinkOrOtherNonRegular,
  MARKER_NAME,
  LINEAGE_NAME,
  MARKER_FORMAT,
  MARKER_VERSION,
  MAX_LOCAL_JSON_BYTES,
  MAX_FIRST_LINE_BYTES,
  ULID_ALPHABET,
  OVERSIZED_FIRST_ENTRY,
  MALFORMED_FIRST_ENTRY,
} from '@adlc/tickets/lib/manifest-primitives.mjs';
