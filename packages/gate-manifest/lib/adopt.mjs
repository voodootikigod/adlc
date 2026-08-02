// adopt.mjs — the operator remediation for an ambiguous lineage
// (spec §7.1(b), ticket T-01KYZDJTF7WE40JH25QTNAWB1Y).
//
// When two committed segments declare the same branch and no local `.lineage`
// token disambiguates them, every token-less write fails closed. That refusal
// is correct — guessing which lineage to extend silently forks it — but it
// leaves no way forward. Two clones of one branch, each writing before seeing
// the other, produce exactly this state legitimately. `adopt` is the way out:
// an operator names the lineage to continue and this writes the local token.
//
// WHY THIS MUST AUTHENTICATE. The `.lineage` token is a TRUST anchor, not a
// pointer: `readOwnChains`'s peeked path treats a token match as proof this
// checkout itself minted the segment and skips signature verification on that
// basis. So adopt applies exactly the gate `resolveOpenSegment` applies to a
// recovered candidate — chain intact under the key, AND the branch-bearing
// first entry carrying a verified v2 signature — and honors the marker's
// persisted auth mode. Anything less would make adopt a supported bypass of
// that gate from the other side.
//
// Adopt NEVER edits committed bytes. It writes one gitignored local file.

import { existsSync } from 'node:fs';
import { ADLC_DIR } from '@adlc/core';
import {
  isSegmentedRepo, currentBranch, markerPath, lineagePath,
  writeLineageToken, readBoundedJsonNoFollow, peekOpenSegment,
} from './lineage.mjs';
import { segmentPath, discoverSegments, readRawLines, ulidOf } from './forest.mjs';
import { verifyChain } from './verify.mjs';
import { verifyEntrySig } from './sign.mjs';

/**
 * The same acceptance `resolveOpenSegment` gives a recovered candidate:
 * leniently valid chain (an honest unsigned legacy prefix is tolerated;
 * tampered or unsigned-after-signed entries are not) AND a first entry
 * carrying a verified v2 signature — v1 does not sign `branch`, so a v1
 * signature can never authenticate the identity claim being adopted.
 */
function authenticate(dir, name, key) {
  const lines = readRawLines(segmentPath(dir, name));
  let first = null;
  // An empty segment file lands here too: lines[0] is undefined, so reading
  // .line throws into this same catch. One refusal path, not two — a
  // separate emptiness guard would be unreachable behind the wrong-branch
  // check below (an empty file declares no branch), i.e. untestable.
  try { first = JSON.parse(lines[0].line); } catch { return { ok: false, first: null }; }
  if (key === null) return { ok: false, first }; // keyless: nothing can be authenticated
  const chain = verifyChain(lines, { key, requireSignatures: false, anchorOnFirst: true });
  const firstAuthenticated = first.sigVersion === 2 && verifyEntrySig(key, first);
  return { ok: chain.valid && firstAuthenticated, first };
}

function describeCandidate(dir, name, key) {
  const lines = readRawLines(segmentPath(dir, name));
  let firstTs = null;
  let lastTs = null;
  try { firstTs = JSON.parse(lines[0].line).ts ?? null; } catch { /* reported as null */ }
  try { lastTs = JSON.parse(lines.at(-1).line).ts ?? null; } catch { /* reported as null */ }
  return {
    name,
    entries: lines.length,
    firstTs,
    lastTs,
    authenticated: authenticate(dir, name, key).ok,
  };
}

/**
 * Enumerate this branch's candidate segments, or plan a specific adoption.
 *
 * Candidates are enumerated DIRECTLY rather than through
 * `recoverOpenSegment`, which throws on exactly the ambiguity adopt exists
 * to resolve — the remediation cannot depend on the thing it remediates.
 *
 * @returns {{ decision: 'list'|'adopted'|'refuse-not-segmented'|'refuse-detached-head'|'refuse-keyed-forest'|'refuse-unknown-segment'|'refuse-wrong-branch'|'refuse-unauthenticated', reason?: string, branch?: string, candidates?: object[], segment?: string, token?: object }}
 */
export function planAdopt(dir = ADLC_DIR, { cwd = process.cwd(), key = null, segment = null } = {}) {
  if (!isSegmentedRepo(dir)) {
    return { decision: 'refuse-not-segmented', reason: 'this repository is not in forest mode — there is no lineage to adopt' };
  }
  const branch = currentBranch(cwd);
  if (branch === null) {
    return { decision: 'refuse-detached-head', reason: 'detached HEAD has no branch identity to bind a lineage token to — check out the branch first' };
  }
  // A keyed-mode forest refuses keyless adoption, mirroring the resolvers'
  // persisted-auth enforcement: without the key nothing here can be
  // authenticated, and an unauthenticated token is precisely the bypass
  // this command must not become.
  const marker = readBoundedJsonNoFollow(markerPath(dir));
  if (marker && marker.auth === 'keyed' && key === null) {
    return { decision: 'refuse-keyed-forest', reason: 'this forest was activated in keyed mode, but no signing key is available to authenticate the segment being adopted; configure the manifest key' };
  }

  const { valid } = discoverSegments(dir);
  const mine = valid.filter((name) => {
    const lines = readRawLines(segmentPath(dir, name));
    if (lines.length === 0) return false;
    try { return JSON.parse(lines[0].line).branch === branch; } catch { return false; }
  });

  if (segment === null) {
    return { decision: 'list', branch, candidates: mine.map((name) => describeCandidate(dir, name, key)) };
  }

  // Named adoption. `valid` membership is the grammar/traversal check: a name
  // that discoverSegments did not classify as a real segment of THIS store
  // is never openable, so path escapes and malformed names refuse here.
  if (!valid.includes(segment) || !existsSync(segmentPath(dir, segment))) {
    return { decision: 'refuse-unknown-segment', reason: `no segment named ${segment} exists in this store`, branch, candidates: mine.map((name) => describeCandidate(dir, name, key)) };
  }
  const { ok, first } = authenticate(dir, segment, key);
  if (!mine.includes(segment)) {
    return { decision: 'refuse-wrong-branch', reason: `segment ${segment} declares branch ${JSON.stringify(first?.branch ?? null)}, not ${JSON.stringify(branch)} — adopting it would bind this checkout to a different lineage`, branch };
  }
  if (!ok) {
    return { decision: 'refuse-unauthenticated', reason: `segment ${segment} cannot be authenticated with the available key (broken chain, or its branch-bearing first entry lacks a verified v2 signature) — a token makes downstream readers trust it without re-verifying, so adopt refuses`, branch };
  }
  const ulid = ulidOf(segment);
  if (!ulid) {
    return { decision: 'refuse-unknown-segment', reason: `segment ${segment} has no readable lineage ULID in its name`, branch };
  }
  return { decision: 'adopted', branch, segment, token: { segment, ulid, branch } };
}

/**
 * Execute the plan. Dry-run (write: false) returns it untouched with
 * `written: false`. On write, the token is published and then READ BACK
 * through `peekOpenSegment` — that resolver validates the recorded ULID
 * against the segment, and a mismatch is silently ignored, so without this
 * check a bad write would report success while changing nothing.
 *
 * @returns {ReturnType<typeof planAdopt> & { written: boolean }}
 */
export function adopt(dir = ADLC_DIR, { cwd = process.cwd(), key = null, segment = null, write = false } = {}) {
  const plan = planAdopt(dir, { cwd, key, segment });
  if (plan.decision !== 'adopted' || !write) return { ...plan, written: false };

  writeLineageToken(dir, plan.token);
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked?.name !== plan.segment) {
    throw new Error(`wrote a lineage token for ${plan.segment} that does not resolve (${peeked ? `resolves to ${peeked.name}` : 'resolves to nothing'}) — the token at ${lineagePath(dir)} is inert; remove it and re-run`);
  }
  return { ...plan, written: true };
}
