// verify.mjs — walk raw lines and validate the hash chain, across the whole
// chain forest (root + segments) per docs/specs/segmented-gate-manifest.md §5.
// Each entry's `prev` must equal sha256(previous raw line).
// Sequence numbers must be strictly monotonically increasing, per chain.

import { sha256, ledgerPath, ADLC_DIR } from '@adlc/core';
import { verifyEntrySig } from './sign.mjs';
import { discoverSegments, readRawLines, segmentPath, resolveAnchor, detectAnchorCycle } from './forest.mjs';
import { validateKeyParam } from '@adlc/tickets/lib/key-contract.mjs';

/**
 * Result of a chain verification.
 * @typedef {object} VerifyResult
 * @property {boolean} valid
 * @property {string} message    human-readable summary
 * @property {number} count      number of entries checked (whole forest)
 * @property {number} segments   number of valid segment files found (0 for a
 *                                segment-free repo)
 * @property {boolean} signed    true only when a key was present AND every
 *                               entry verified cryptographically. When no key
 *                               is set this is false: callers MUST NOT claim
 *                               cryptographic provenance from a hash-chain-only
 *                               pass.
 * @property {object|null} break  null if valid; { seq, lineNo, reason, segment }
 *                                 if broken (`segment` is 'root' or the segment
 *                                 filename)
 */

/**
 * Verify ONE chain's raw lines: `seq` strictly increasing from 1, `prev` =
 * sha256(previous raw line), fork-anchor placement (§4.4), and — when a key
 * is configured — HMAC signatures.
 *
 * Extracted so the same algorithm runs once for the root and once per
 * segment; forest orchestration (anchors, cycles) lives in verify() below.
 * The legacy-unsigned-prefix tolerance below (`seenSignedEntry`) is evaluated
 * PER CHAIN — each call gets its own local flag. In practice only the root
 * chain has a genuine legacy prefix (this repo's own history predates
 * signing; segments are a new concept introduced only once signing already
 * exists) — but per-chain is the correct, simplest rule regardless: a
 * segment with its own honest unsigned prefix is treated exactly like root's.
 *
 * Security model:
 *  - No key in env  → hash chain checked only; result.signed = false. The chain
 *    proves *internal consistency*, not authorship — a writer can forge it.
 *  - Key in env     → every entry MUST carry a valid sig. A missing sig
 *    ('unsigned entry') or wrong sig ('signature invalid') breaks the chain.
 *    This defeats the forge-from-scratch attack: without the key an attacker
 *    cannot produce valid signatures, so verify (run WITH the key) returns
 *    valid:false.
 *  - requireSignatures:false → tolerate a missing sig only on the LEGACY PREFIX:
 *    entries before the first entry in THIS CHAIN that carries a sig (recorded
 *    before signing was ever enabled). Once the scan passes that first signed
 *    entry, every later entry is "signed-era" and a missing sig on it breaks
 *    the chain exactly like strict mode — an attacker cannot regress a signed
 *    chain back to unsigned by appending plain entries after the fact. A
 *    PRESENT-but-invalid sig is STILL rejected everywhere (tampering), so this
 *    is "an honest unsigned history is OK", not "tampered signatures are OK" or
 *    "unsigned entries are OK anywhere". signed=false.
 *
 *    HONEST LIMIT: if a chain contains ZERO signed entries, `seenSignedEntry`
 *    never flips, so the WHOLE chain is treated as legacy prefix and reported
 *    valid:true. A wholesale-forged, entirely-unsigned chain (sha256 is public
 *    and keyless — this needs no secret) is therefore indistinguishable from an
 *    honest chain that genuinely predates signing end to end. This mode does
 *    NOT prove "no forgery" in that case, only "no signed entry was tampered
 *    with, and no unsigned entry follows a signed one" — a caller that needs a
 *    stronger guarantee must check for at least one verified signed entry itself
 *    (result.signed alone does not distinguish this: it is false in both the
 *    zero-signed-entries case and the some-signed-entries lenient-pass case).
 *
 * @param {{line: string, lineNo: number}[]} nonEmpty  from readRawLines()
 * @param {object} opts
 * @param {string|null} opts.key
 * @param {boolean} opts.requireSignatures  when false, tolerate a missing sig
 *   on the contiguous legacy prefix (entries before the first signed entry in
 *   THIS chain), but still reject a missing sig on any entry after that
 *   point, and reject any entry whose PRESENT signature does not verify,
 *   anywhere. When true, every entry must be signed and valid.
 * @param {boolean} opts.anchorOnFirst  when true, the FIRST entry MUST carry a
 *   top-level `anchor` field and no other entry may; when false (the root
 *   chain), NO entry may carry one. Required, not defaulted: every call site
 *   below passes it explicitly, so a default here would be unreachable dead
 *   code. Anchor VALUE resolution (does it point somewhere real) is a
 *   forest-level concern, done by the caller.
 * @returns {VerifyResult & {lastRawLine: string|null, firstAnchor: object|null|undefined}}
 *   `firstAnchor` is the first entry's anchor field, or `undefined` if there
 *   were no entries to anchor.
 */
export function verifyChain(nonEmpty, { key, requireSignatures, anchorOnFirst }) {
  if (nonEmpty.length === 0) {
    // A segment (unlike the root) MUST have a first entry carrying the fork
    // anchor (§4.4) — an empty segment file has no anchor to check, but it
    // must not pass by vacuous truth: that would let a truncated/crashed
    // writer's empty file (or an empty file dropped by tampering) verify as
    // a legitimate null-anchored zero-entry segment.
    if (anchorOnFirst) {
      return { valid: false, message: 'empty segment file has no first entry to carry the required anchor', count: 0, signed: false, break: { seq: null, lineNo: null, reason: 'empty segment file' }, lastRawLine: null, firstAnchor: undefined };
    }
    return { valid: true, message: 'empty manifest', count: 0, signed: false, break: null, lastRawLine: null, firstAnchor: undefined };
  }

  let prevRawLine = null;
  let prevSeq = null;
  let firstAnchor;
  let seenSignedEntry = false; // set once an entry with a verified sig has been seen (per-chain)

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

    // Check prev hash
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

    // Check seq monotonicity
    if (prevSeq !== null && entry.seq <= prevSeq) {
      return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'seq not monotonically increasing' }, `chain broken at seq ${entry.seq} (line ${lineNo}): seq must be strictly increasing`);
    }

    // §4.4 fork anchor placement: required on a segment's first entry, absent
    // everywhere else (including every root entry, when anchorOnFirst=false).
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

    // Check HMAC signatures when a key is configured. Two independent conditions:
    //
    //   MISSING sig — gated by requireSignatures AND position. In the default
    //     (true) mode EVERY entry must carry a sig, so a forged-from-scratch chain
    //     is rejected. In the lenient (false) mode a missing sig is tolerated ONLY
    //     while no earlier entry in THIS CHAIN has carried a sig yet — i.e. it is
    //     still inside the contiguous legacy prefix from before signing was ever
    //     enabled. As soon as one signed entry has been seen, `seenSignedEntry`
    //     flips true and a later missing sig breaks the chain just like strict
    //     mode: an attacker who controls the tail of a signed chain cannot
    //     regress it to unsigned by appending plain entries.
    //   PRESENT-but-INVALID sig — rejected in BOTH modes, at ANY position. A sig
    //     that is present but does not verify means the entry's bytes were altered
    //     after signing (or the wrong key signed it). Skipping that in lenient mode
    //     would let an attacker TAMPER a signed entry — e.g. rewrite a signed
    //     `needs-attention` revocation so it no longer matches the gate — recompute
    //     the public prev-hashes, and pass "chain-only" verification. Lenient means
    //     "an honest unsigned prefix is OK", NOT "tampered signatures are OK" and
    //     NOT "unsigned entries are OK anywhere". (Codex #354 re-review F1.)
    if (key !== null) {
      const hasSig = entry.sig !== undefined && entry.sig !== null;
      if (!hasSig) {
        const toleratedLegacyPrefix = !requireSignatures && !seenSignedEntry;
        if (!toleratedLegacyPrefix) {
          return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'unsigned entry' }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`);
        }
      } else if (!verifyEntrySig(key, entry)) {
        return fail(lineNo - 1, { seq: entry.seq, lineNo, reason: 'signature invalid' }, `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`);
      } else {
        seenSignedEntry = true;
      }
    }

    prevRawLine = line;
    prevSeq = entry.seq;
  }

  const signed = key !== null && requireSignatures;
  return {
    valid: true,
    message: signed ? `manifest ok, signed (${nonEmpty.length} entries)` : `manifest ok (${nonEmpty.length} entries)`,
    count: nonEmpty.length,
    signed,
    break: null,
    lastRawLine: prevRawLine,
    firstAnchor,
  };

  function fail(count, breakInfo, message) {
    return { valid: false, message, count, signed: false, break: breakInfo, lastRawLine: null, firstAnchor: undefined };
  }
}

/**
 * Verify the manifest ledger's hash chain — and, when ADLC_MANIFEST_KEY is
 * set, the HMAC signature of every entry that carries one — across the whole
 * chain forest: the root plus every valid segment under `manifest.d/`.
 *
 * A segment-free repo (no `manifest.d/`, or an empty one) verifies with
 * results byte-identical in meaning to the pre-forest single-chain verifier
 * (docs/specs/segmented-gate-manifest.md §5, final paragraph) — this function
 * takes that fast path explicitly rather than special-casing zero segments
 * inside the general walk.
 *
 * @param {string} [dir]  ledger directory (default ADLC_DIR)
 * @param {object} [opts]
 * @param {boolean} [opts.requireSignatures=true]  see verifyChain
 * @returns {VerifyResult}
 */
export function verify(dir = ADLC_DIR, { requireSignatures = true, key: keyParam } = {}) {
  const key = validateKeyParam(keyParam);
  const rootRaw = readRawLines(ledgerPath('manifest', dir));
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

  if (segmentNames.length === 0) {
    // Fast path: byte-identical to the pre-forest verifier (AC2) for the
    // valid/message/count/signed fields; break gets the same `segment: 'root'`
    // label every other failure path in this function returns, for a
    // consistent contract (an AC2 golden test never inspects break.segment,
    // since the pre-forest verifier never had one to match).
    const result = verifyChain(rootRaw, { key, requireSignatures, anchorOnFirst: false });
    return { valid: result.valid, message: result.message, count: result.count, segments: 0, signed: result.signed, break: result.break ? { ...result.break, segment: 'root' } : null };
  }

  const rootResult = verifyChain(rootRaw, { key, requireSignatures, anchorOnFirst: false });
  if (!rootResult.valid) {
    return { valid: false, message: rootResult.message, count: rootResult.count, segments: segmentNames.length, signed: false, break: { ...rootResult.break, segment: 'root' } };
  }

  // Verify each segment's internal chain, and collect the data anchor
  // resolution + cycle detection need: per-chain seq->rawLine maps and each
  // segment's first-entry anchor.
  const chainsBySeq = new Map(); // 'root' | segmentName -> Map(seq -> rawLine)
  chainsBySeq.set('root', seqMap(rootRaw));
  const anchorBySegment = new Map(); // segmentName -> anchor (object or null)
  let totalCount = rootResult.count;
  // An empty chain (root-less repo's empty root, or a degenerate empty segment
  // file) reports signed:false on its own — it has nothing to sign — but must
  // not drag down a forest whose non-empty chains are all validly signed.
  let allSigned = rootResult.count === 0 ? true : rootResult.signed;

  for (const name of segmentNames) {
    const raw = readRawLines(segmentPath(dir, name));
    const result = verifyChain(raw, { key, requireSignatures, anchorOnFirst: true });
    if (!result.valid) {
      return { valid: false, message: `manifest.d/${name}: ${result.message}`, count: totalCount + result.count, segments: segmentNames.length, signed: false, break: { ...result.break, segment: name } };
    }
    chainsBySeq.set(name, seqMap(raw));
    anchorBySegment.set(name, result.firstAnchor === undefined ? null : result.firstAnchor);
    totalCount += result.count;
    allSigned = allSigned && (result.count === 0 ? true : result.signed);
  }

  // §5.4 — anchor resolution.
  for (const name of segmentNames) {
    const anchor = anchorBySegment.get(name);
    const resolved = resolveAnchor(anchor, chainsBySeq, rootResult.count > 0);
    if (!resolved.ok) {
      return { valid: false, message: `manifest.d/${name}: ${resolved.reason}`, count: totalCount, segments: segmentNames.length, signed: false, break: { seq: null, lineNo: null, reason: resolved.reason, segment: name } };
    }
  }

  // §5.5 — reject anchor cycles.
  const cycleCheck = detectAnchorCycle(anchorBySegment);
  if (!cycleCheck.ok) {
    return { valid: false, message: `manifest.d/${cycleCheck.segment}: anchor cycle detected`, count: totalCount, segments: segmentNames.length, signed: false, break: { seq: null, lineNo: null, reason: 'anchor cycle', segment: cycleCheck.segment } };
  }

  const signed = allSigned; // signed:true only when every chain in the forest verified signed
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

function seqMap(nonEmpty) {
  const m = new Map();
  for (const { line } of nonEmpty) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry && Number.isInteger(entry.seq)) m.set(entry.seq, line);
  }
  return m;
}
