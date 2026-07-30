// record.mjs — build and append a manifest entry.
// IMPORTANT: chain integrity depends on sha256(raw previous line bytes).
// appendManifestEntry derives that link from appendEntries' byte-exact state
// while holding the ledger lock; parsed/re-serialized entries are never used.

import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256, hashFiles, appendEntries, ADLC_DIR } from '@adlc/core';
import { signEntry } from './sign.mjs';
import { verify } from './verify.mjs';
import { isSegmentedRepo } from './lineage.mjs';
import { appendToSegment } from './segment-writer.mjs';
import { discoverSegments } from './forest.mjs';
import { validateKeyParam } from '@adlc/tickets/lib/key-contract.mjs';

// `segment` is reserved too: forest.mjs's readManifestForest annotates every
// entry it returns with its source segment (see sign.mjs's canonicalEntryBytes
// for why that annotation must never be signed) — a caller-supplied `segment`
// would be indistinguishable from that read-only annotation. `anchor` is
// reserved per spec §4.4: only a segment's first entry may carry one, and
// only the writer itself (segment-writer.mjs) may set it. `branch` (T-MANIFEST-
// FOREST, fourth round, adversarial-review finding) is reserved for the same
// reason as `anchor`: it is the non-lossy identity recoverOpenSegment matches
// on and is part of the signed byte range on a v2 entry — a caller-supplied
// `branch` would silently overwrite the writer's own `currentBranch()` value
// and get authenticated as if genuine, letting a payload from branch A sign
// itself as belonging to branch B.
const RESERVED_CHAIN_FIELDS = ['seq', 'prev', 'sig', 'sigVersion', 'segment', 'anchor', 'branch'];

/**
 * Atomically append an arbitrary top-level evidence entry to the C11 manifest.
 * Sequence allocation and the byte-exact previous-line hash happen under the
 * same ledger lock as the write, so runner and gate evidence share one chain.
 *
 * `cwd` (used only for segmented-repo branch resolution, spec §7.1) defaults
 * to `dirname(dir)`, NOT `process.cwd()` (adversarial-review finding): every
 * ledger dir in this codebase is `<repo-root>/.adlc`, so the target repo's
 * root is `dir`'s parent. A caller that runs from one repo but records into
 * ANOTHER's ledger via an explicit `dir` (e.g. an orchestrator recording into
 * a worker checkout) would otherwise derive the branch from the WRONG
 * repository — silently binding a segment to the controller's branch instead
 * of the target's. `dirname('.adlc')` is `'.'`, which resolves identically to
 * `process.cwd()` for the common case, so this changes nothing there.
 */
export function appendManifestEntry(payload, dir = ADLC_DIR, { signatureVersion = 2, cwd = dirname(dir), key } = {}) {
  const signingKey = validateKeyParam(key);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('manifest payload must be an object');
  }
  for (const field of RESERVED_CHAIN_FIELDS) {
    if (Object.hasOwn(payload, field)) {
      throw new Error(`manifest payload must not provide reserved chain field: ${field}`);
    }
  }

  // spec §7: once a repo has cut over (marker or a root manifest-cutover
  // entry — see lineage.mjs), EVERY append routes to the current lineage's
  // segment instead of root.
  if (isSegmentedRepo(dir)) {
    return appendToSegment(payload, dir, { signatureVersion, cwd, key: signingKey });
  }

  const [entry] = appendEntries('manifest', (state) => {
    // RACE (adversarial-review finding): the isSegmentedRepo check above runs
    // BEFORE this callback acquires the root ledger lock. The migration
    // ceremony's own cutover append (spec §8 step 6) serializes on that SAME
    // lock, so a writer that lost the race — it checked "not segmented",
    // then blocked on the lock while cutover ran to completion, then finally
    // got the lock — must not blindly append behind a cutover it never saw.
    // Re-checking here, now that the lock (and therefore an up-to-date view
    // of root) is actually held, is spec §7 point 3's "MUST refuse to append
    // to the root" — the check above handles the common case cheaply; THIS
    // is the one that is actually race-proof.
    if (isSegmentedRepo(dir)) {
      throw new Error('manifest chain is frozen; this repo uses .adlc/manifest.d/ — upgrade adlc if you are seeing this locally');
    }
    if (state.skipped.length > 0) {
      throw new Error(`manifest contains malformed JSON at line ${state.skipped[0].line}`);
    }
    if (state.rawLines.length > 0) {
      // Chain-INTEGRITY only: we must not append onto a corrupted/unchained tail,
      // but we must NOT demand that pre-existing history be signed. The shared
      // manifest legitimately holds unsigned entries from before signing was enabled;
      // a full sig-requiring verify here would make it impossible to append a NEW
      // (signed, below) entry to such a manifest. Provenance is enforced by signing
      // this entry and by readers sig-checking the specific entries they trust.
      //
      // requireSignatures:false is SCOPED (see verify.mjs): it tolerates a missing
      // sig only on the contiguous prefix before the first signed entry. If a prior
      // append happened to run without a key AFTER signing was already adopted (env
      // misconfiguration), THAT entry now breaks this check going forward — this
      // append (and any other) refuses until the chain is repaired (`repair-chain`).
      // That is intentional: silently continuing to append unsigned entries onto a
      // signed ledger would degrade provenance with no signal that anything changed.
      const integrity = verify(dir, { requireSignatures: false, key: signingKey });
      if (!integrity.valid) {
        throw new Error(`manifest chain is invalid: ${integrity.message}`);
      }
    } else {
      // Adversarial-review finding: a ROOTLESS segmented repo (anchor: null
      // segments, activated only via .store.json since there is no cutover
      // entry yet to fall back on — greenfield scaffold / slice 4) has no
      // OTHER signal once that marker is lost, corrupted, or unreadable:
      // isSegmentedRepo already returned false above, so this empty-root
      // branch is the LAST checkpoint before a root gets created for the
      // first time. Spec §4.4: "anchor: null is unavailable once a root
      // exists" — silently creating one here would retroactively invalidate
      // every existing rootless segment's forest membership. Fail closed
      // instead of corrupting real evidence that was valid a moment ago.
      const { valid: existingSegments } = discoverSegments(dir);
      if (existingSegments.length > 0) {
        throw new Error(
          `refusing to create the root manifest: manifest.d/ already holds ${existingSegments.length} segment(s) anchored to nothing (anchor: null), legal only in a rootless forest — creating a root now would make every one of them invalid (spec §4.4). This usually means the activation marker (.adlc/manifest.d/.store.json) was lost or corrupted; restore it rather than appending to root.`
        );
      }
    }
    const previous = state.entries.at(-1);
    if (previous && (!Number.isInteger(previous.seq) || previous.seq < 1)) {
      throw new Error('manifest tail is not hash-chain compatible: missing positive seq');
    }

    const normalized = {
      ...payload,
      gate: payload.gate ?? payload.type ?? 'evidence',
      ts: payload.ts ?? new Date().toISOString(),
      files: payload.files ?? {},
    };
    const chained = {
      seq: previous ? previous.seq + 1 : 1,
      ...normalized,
      prev: state.lastRawLine === null ? null : sha256(state.lastRawLine),
    };
    if (signingKey) {
      if (signatureVersion === 2) chained.sigVersion = 2;
      chained.sig = signEntry(signingKey, chained);
    }
    return [chained];
  }, dir);
  return entry;
}

/**
 * Parse JSON data from a --data flag string.
 * Returns parsed object or throws with a clear message.
 */
export function parseData(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--data is not valid JSON: ${err.message}`);
  }
}

/**
 * Parse a comma-separated file list from --files flag string.
 * Returns array of trimmed non-empty paths.
 */
export function parseFileList(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Read the last raw line (non-empty) from a ledger file.
 * Returns null if the file does not exist or has no non-empty lines.
 */
export function readLastRawLine(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf8');
  // Split on newline but keep exact bytes by splitting the buffer
  const lines = content.split('\n');
  // Walk backwards to find the last non-empty line
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i];
  }
  return null;
}

/**
 * Build a new manifest entry object (pure, side-effect-free).
 *
 * @param {object} opts
 * @param {string} opts.gate        gate name
 * @param {string|undefined} opts.ticket  ticket id (optional)
 * @param {object|undefined} opts.data   parsed JSON data (optional)
 * @param {string[]} opts.filePaths  list of files to hash
 * @param {string|null} opts.prevRawLine  raw bytes of the previous JSONL line (or null)
 * @param {number} opts.prevSeq     sequence number of previous entry (0 if none)
 * @param {string} opts.ts          ISO timestamp
 * @param {string|null} [opts.key]  HMAC signing key; when present, entry gets a `sig`
 * @returns manifest entry object
 */
export function buildEntry({ gate, ticket, data, filePaths, prevRawLine, prevSeq, ts, key = null }) {
  const entry = {
    seq: prevSeq + 1,
    gate,
    ts,
  };

  if (ticket !== undefined) entry.ticket = ticket;
  if (data !== undefined) entry.data = data;

  entry.files = filePaths.length > 0 ? hashFiles(filePaths) : {};
  entry.prev = prevRawLine !== null ? sha256(prevRawLine) : null;

  // Sign last: `sig` is computed over the canonical bytes of all other fields
  // (see sign.mjs) and appended as the final field so it is excluded from the
  // signed payload. Without a key the entry is unsigned and verify will flag it.
  if (key) entry.sig = signEntry(key, entry);

  return entry;
}

/**
 * Record a new entry in the manifest ledger.
 *
 * @param {object} opts
 * @param {string} opts.gate
 * @param {string|undefined} opts.ticket
 * @param {string|undefined} opts.rawData   raw --data string (parsed here)
 * @param {string|undefined} opts.rawFiles  raw --files string (parsed here)
 * @param {string} [opts.dir]  ledger directory (default ADLC_DIR)
 * @returns the recorded entry object
 * @throws Error for malformed --data JSON
 */
export function record({ gate, ticket, rawData, rawFiles, dir = ADLC_DIR, key }) {
  const signingKey = validateKeyParam(key);
  const data = parseData(rawData);
  const filePaths = parseFileList(rawFiles);
  const payload = { gate, ts: new Date().toISOString() };
  if (ticket !== undefined) payload.ticket = ticket;
  if (data !== undefined) payload.data = data;
  payload.files = filePaths.length > 0 ? hashFiles(filePaths) : {};
  return appendManifestEntry(payload, dir, { signatureVersion: 1, key: signingKey });
}

/**
 * A one-line, side-effect-free reminder to conclude P6 by completing the ticket
 * (T74). Recording a `p6-accept` verdict is evidence, NOT completion — this
 * bridge never mutates a ticket, it only points the operator at the command that
 * does. Returns null when the gate is not a P6 acceptance gate or no ticket was
 * named, so there is nothing to remind about. The `p6-accept` prefix also matches
 * the `p6-acceptance-packet` gate the acceptance path records.
 *
 * @param {string} gate  the recorded gate name
 * @param {string|undefined} ticket  the --ticket id, if any
 * @returns {string|null}
 */
export function ticketCompletionReminder(gate, ticket) {
  if (typeof gate !== 'string' || typeof ticket !== 'string' || ticket === '') return null;
  if (!/^p6-accept/.test(gate)) return null;
  return `reminder: recording ${gate} is evidence, not completion — conclude P6 with ` +
    `\`adlc ticket complete ${ticket} --write\` (add \`--authorize\` when the ticket is railed).`;
}
