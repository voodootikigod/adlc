// manifest-segments.mjs — segmented gate-manifest support for ticket evidence.
// Shared primitives are single-sourced in ./manifest-primitives.mjs and re-exported here.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from './canonical.mjs';
import {
  segmentPath,
  lineagePath,
  discoverSegments,
  canonicalEntryBytes,
  entrySigValid,
  isSegmentedRepo,
  generateSegmentUlid,
  deriveSlug,
  currentBranch,
  readLineageToken,
  ulidOf,
  peekOpenSegment,
  recoverOpenSegment,
  resolveOpenSegment,
} from './manifest-primitives.mjs';

export {
  segmentPath,
  lineagePath,
  discoverSegments,
  canonicalEntryBytes,
  entrySigValid,
  isSegmentedRepo,
  generateSegmentUlid,
  deriveSlug,
  currentBranch,
  readLineageToken,
  ulidOf,
  peekOpenSegment,
  recoverOpenSegment,
  resolveOpenSegment,
};

function readRawLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function parseLines(lines) {
  return lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

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

function signedEntriesOnly(lines, key) {
  return lines.filter((line) => entrySigValid(key, JSON.parse(line)));
}

export function forestChainsIntact(dir, { key = null } = {}) {
  if (!chainIsIntact(readRawLines(join(dir, 'manifest.jsonl')), key)) return false;
  const { valid, invalid } = discoverSegments(dir);
  if (invalid.length > 0) return false; // a non-conforming object anywhere invalidates the whole forest
  return valid.every((name) => chainIsIntact(readRawLines(segmentPath(dir, name)), key));
}

export function readForestEntries(dir) {
  const root = parseLines(readRawLines(join(dir, 'manifest.jsonl')));
  const segments = discoverSegments(dir).valid.flatMap((name) => parseLines(readRawLines(segmentPath(dir, name))));
  return [...root, ...segments];
}

/**
 * Root's chain, then this branch's own segment chain — never another lineage's.
 * Separate arrays: seq restarts per chain, so a later array is newer than an
 * earlier one; compare seq only within one array.
 * Own segment = .lineage token match, else the single segment whose first entry
 * declares this branch. With a key, each chain must pass chainIsIntact and only
 * validly signed entries are returned. Throws instead of returning "no evidence"
 * when it cannot tell: broken chain, non-empty chain with no signed entry, empty
 * own segment, keyless/ambiguous recovery candidate, detached HEAD with segments.
 */
export function readOwnChains(dir, { cwd = dirname(dir), allowRecovery = false, key = null } = {}) {
  const rootRaw = readRawLines(join(dir, 'manifest.jsonl'));
  // Root and a token-matched (peeked) segment are not identity-ambiguous the
  // way a RECOVERED segment is — root is canonically root, and the local
  // `.lineage` token is proof this checkout itself minted the peeked
  // segment, not a self-reported claim from untrusted content. Both still
  // get chainIsIntact's tamper/continuity check when a key is available
  // (round 6 — push.mjs previously trusted root and a token-matched segment
  // with NO verification at all, even with a real key passed in, so an
  // attacker with commit-but-not-key access could append an unsigned forged
  // entry there and have it published).
  //
  // AND (round 7 + round 8): once verified intact, only entries with a
  // genuinely valid signature are handed back — never merely "at least one
  // exists" (round 7's original check, closed further in round 8: see
  // signedEntriesOnly's own doc for why an unsigned PREFIX can otherwise be
  // laundered into trust by an unrelated later signature). Unlike the
  // recovered path's identical requirement below, this is NOT about identity
  // (root/peeked aren't self-claimed) — it is about not letting "this repo
  // happens to have never signed anything yet" (or "not yet, for THIS
  // entry") become "so nothing here needs signing, ever, even once a key
  // exists."
  let rootLines = rootRaw;
  if (key !== null) {
    if (!chainIsIntact(rootRaw, key)) {
      throw new Error('root manifest failed chain or signature verification — refusing to trust it');
    }
    rootLines = signedEntriesOnly(rootRaw, key);
    // Empty is not "unsigned" — a rootless segmented repo genuinely has
    // nothing in root, which is not a forgery risk (nothing to distrust);
    // only a NON-EMPTY chain with zero validly-signed entries is the concern.
    if (rootRaw.length > 0 && rootLines.length === 0) {
      throw new Error('root manifest has no signed entries — cannot authenticate it with the available key, refusing to trust it');
    }
  }
  const root = parseLines(rootLines);
  if (!isSegmentedRepo(dir)) return [root];
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) {
    const peekedRaw = readRawLines(segmentPath(dir, peeked.name));
    // Structural, not a trust decision (adversarial-review finding,
    // T-MANIFEST-FOREST ninth round) — checked regardless of `key`: a
    // segment this checkout's OWN token resolves to being zero bytes is not
    // "nothing here" the way an empty ROOT legitimately can be. Every real
    // segment's mint atomically writes its anchor-carrying first entry
    // (gate-manifest's verifyChain: an empty segment "has no first entry to
    // carry the required anchor"), so zero bytes here can only mean a crash
    // between file creation and first append, or truncation/tampering.
    if (peekedRaw.length === 0) {
      throw new Error(`segment ${peeked.name} is empty — a real segment always has a first entry, refusing to trust it`);
    }
    let peekedLines = peekedRaw;
    if (key !== null) {
      if (!chainIsIntact(peekedRaw, key)) {
        throw new Error(`segment ${peeked.name} failed chain or signature verification — refusing to trust it`);
      }
      peekedLines = signedEntriesOnly(peekedRaw, key);
      // peekedRaw is never empty here — the unconditional check above already
      // refused an empty segment before this point is reached.
      if (peekedLines.length === 0) {
        throw new Error(`segment ${peeked.name} has no signed entries — cannot authenticate it with the available key, refusing to trust it`);
      }
    }
    return [root, parseLines(peekedLines)];
  }
  if (!allowRecovery) return [root];

  // Beyond this point the token is missing and we are attempting recovery.
  // Two more ways this used to silently look like "no evidence" instead of
  // "cannot determine" (adversarial-review finding, T-MANIFEST-FOREST
  // seventh round) — both get the SAME treatment as an ambiguous recovery
  // match: refuse outright, since a mutating consumer (reassignment) that
  // proceeds as if there's nothing to migrate can permanently strand real
  // evidence under an abandoned ticket ID, and push can wrongly remove a
  // real status label.
  const branch = currentBranch(cwd);
  if (branch === null) {
    // Detached HEAD — a common CI checkout shape (e.g. a PR SHA checked out
    // directly) — has no branch identity to check candidates against AT
    // ALL. If ANY committed segment exists anywhere in this repo, we cannot
    // rule out that one belongs to us; only a genuinely segment-free forest
    // is safe to treat as "nothing to miss".
    if (discoverSegments(dir).valid.length > 0) {
      throw new Error(
        'cannot identify this checkout\'s own segment: detached HEAD has no branch identity to recover by, '
        + 'and committed segments exist — refusing to treat them as absent'
      );
    }
    return [root];
  }
  if (key === null) {
    // A known branch, but nothing can be signature-verified. Check
    // EXISTENCE only via recoverOpenSegment — never trust its content for
    // this purpose, only whether a plausible candidate exists at all — the
    // same "existence check, not a trust decision" pattern used by
    // reassign.mjs before this logic moved into the shared primitive.
    let candidateExists;
    try { candidateExists = recoverOpenSegment(dir, { cwd }) !== null; }
    catch { candidateExists = true; } // ambiguous match — still a candidate, still refuse
    if (candidateExists) {
      throw new Error(
        'a candidate segment for this branch exists but cannot be verified without a signing key — '
        + 'refusing to treat it as absent'
      );
    }
    return [root];
  }

  const recovered = recoverOpenSegment(dir, { cwd });
  if (!recovered) return [root];
  // WHOLE-CHAIN verification, not a per-entry filter (adversarial-review
  // finding, T-MANIFEST-FOREST fourth round, round 2): filtering out entries
  // that individually fail entrySigValid used to silently DROP them from the
  // returned chain rather than refusing the read. A tampered LATER entry
  // (e.g. a real, signed "blocked"/revocation verdict edited by someone
  // without the key, invalidating its own signature) would vanish, leaving
  // an EARLIER, still-validly-signed "clear" verdict as if it were the
  // latest — resurrecting a stale pass past its own revocation. chainIsIntact
  // enforces "once this chain has a signed entry, every LATER entry must also
  // carry a valid signature" (see its own doc) — the SAME whole-chain
  // precondition reassignment (forestChainsIntact) and carry-forward
  // (manifestChainTrustworthy) already require before trusting anything they
  // read; push.mjs was the one consumer with no such precondition of its own,
  // which is why this belongs in the shared primitive, not each caller.
  //
  // chainIsIntact alone is NOT sufficient here, though (round 5 of the same
  // finding): it deliberately tolerates a chain with an unsigned PREFIX —
  // that legacy-unsigned-prefix tolerance is correct for
  // forestChainsIntact's write-time precondition on a segment THIS checkout
  // already owns via a valid token, but a RECOVERED segment is untrusted
  // input claiming an identity this checkout never verified. An attacker
  // without the key can trivially hand-write an entirely unsigned segment
  // that is perfectly hash-chain-consistent and passes chainIsIntact — so
  // recovery filters to entries with a genuinely valid signature (round 8:
  // not merely "at least one exists" — see signedEntriesOnly's own doc for
  // why a lone later signature must not launder an earlier unsigned forged
  // entry into trust).
  const rawLines = readRawLines(segmentPath(dir, recovered.name));
  if (!chainIsIntact(rawLines, key)) {
    throw new Error(`recovered segment ${recovered.name} failed chain or signature verification — refusing to trust it`);
  }
  const signedRecovered = signedEntriesOnly(rawLines, key);
  if (signedRecovered.length === 0) {
    throw new Error(`recovered segment ${recovered.name} failed chain or signature verification — refusing to trust it`);
  }
  return [root, parseLines(signedRecovered)];
}
