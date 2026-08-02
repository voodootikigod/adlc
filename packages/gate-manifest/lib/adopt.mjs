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

// The ONE place a segment's entries are parsed. Returns null when the file
// is empty, unreadable, or its first/last entry is not a JSON OBJECT —
// `JSON.parse('null')` succeeds and yields null, which would otherwise flow
// on and throw when a caller reads `.branch` off it (the twin resolvers
// guard this with `first?.branch`). A null here is REFUSED by the caller,
// never silently excluded: recovery throws on an unreadable first entry
// precisely because such a segment "cannot be safely excluded as a
// candidate either", and adopt must not resolve a state recovery refuses.
function readSegment(dir, name) {
  const lines = readRawLines(segmentPath(dir, name));
  try {
    const first = JSON.parse(lines[0].line);
    const last = JSON.parse(lines.at(-1).line);
    if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
    return { lines, first, last: last && typeof last === 'object' ? last : {} };
  } catch {
    return null;
  }
}

/**
 * Assumes a parsed first entry — see readSegment.
 *
 * With a key: the full gate `resolveOpenSegment` applies to a recovered
 * candidate — leniently valid chain AND a first entry carrying a verified
 * v2 signature (v1 does not sign `branch`, so it can never authenticate the
 * identity being adopted).
 *
 * Without a key, chain intactness alone suffices ONLY in a forest whose
 * marker explicitly declares `auth: "keyless"` — there a token confers no
 * trust the forest does not already grant, since keyless readers skip
 * signature verification by design, and refusing would leave keyless
 * forests with no remedy for an outage they genuinely reach. `allowChainOnly`
 * is therefore driven by an EXPLICIT declaration, never by the absence of a
 * key or the absence of a marker (adversarial-review finding): a
 * cutover-only forest has no marker at all, so conflating "no key supplied"
 * with "forest is legitimately keyless" would let an operator who merely
 * forgot the env var launder an unsigned segment into the token-trusted
 * fast path.
 */
function authenticate({ lines, first }, key, allowChainOnly) {
  const chain = verifyChain(lines, { key, requireSignatures: false, anchorOnFirst: true });
  if (!chain.valid) return false;
  if (key === null) return allowChainOnly;
  return first.sigVersion === 2 && verifyEntrySig(key, first);
}

function describeCandidate(name, parsed, key, allowChainOnly) {
  return {
    name,
    entries: parsed.lines.length,
    firstTs: parsed.first.ts ?? null,
    lastTs: parsed.last.ts ?? null,
    authenticated: authenticate(parsed, key, allowChainOnly),
  };
}

/**
 * Enumerate this branch's candidate segments, or plan a specific adoption.
 *
 * Candidates are enumerated DIRECTLY rather than through
 * `recoverOpenSegment`, which throws on exactly the ambiguity adopt exists
 * to resolve — the remediation cannot depend on the thing it remediates.
 *
 * @returns {{ decision: 'list'|'adopted'|'refuse-not-segmented'|'refuse-detached-head'|'refuse-keyed-forest'|'refuse-undetermined-auth'|'refuse-nonconforming-store'|'refuse-unreadable-segment'|'refuse-unknown-segment'|'refuse-wrong-branch'|'refuse-unauthenticated', reason?: string, branch?: string, candidates?: object[], segment?: string, token?: object }}
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
  const declaredAuth = readBoundedJsonNoFollow(markerPath(dir))?.auth ?? null;
  if (declaredAuth === 'keyed' && key === null) {
    return { decision: 'refuse-keyed-forest', reason: 'this forest was activated in keyed mode, but no signing key is available to authenticate the segment being adopted; configure the manifest key', branch };
  }
  // Only an EXPLICIT keyless declaration licenses chain-only acceptance. A
  // forest with no marker (cutover-only, or pre-policy) has declared
  // nothing, and "no key was supplied" is far more often a forgotten env
  // var than a deliberate configuration — accepting there would launder an
  // unsigned segment into the token-trusted fast path.
  const allowChainOnly = declaredAuth === 'keyless';
  if (!allowChainOnly && key === null) {
    return { decision: 'refuse-undetermined-auth', reason: 'this forest does not declare an authentication mode (no activation marker), so an unsigned segment cannot be told apart from a legitimately keyless one — supply the manifest key to adopt here', branch };
  }

  // Recovery's INTEGRITY gates, applied before anything else — adopt must
  // not be able to resolve a state recovery would have refused. Once a
  // token exists, `peekOpenSegment` short-circuits both the writer's
  // recovery and the reader's, so a single adopt would convert these
  // fail-closed refusals into permanent silence for this checkout.
  const { valid, invalid } = discoverSegments(dir);
  if (invalid.length > 0) {
    return {
      decision: 'refuse-nonconforming-store',
      reason: `manifest.d/ contains ${invalid.length} non-conforming filesystem object(s) (${invalid.map((i) => i.name).sort().join(', ')}) — one could be a disguised or tampered segment belonging to this branch, so adopting a lineage now would hide it from every later write and read on this checkout; repair the store first`,
      branch,
    };
  }
  const parsedByName = new Map();
  const unreadable = [];
  for (const name of valid) {
    const parsed = readSegment(dir, name);
    if (parsed) parsedByName.set(name, parsed);
    else unreadable.push(name);
  }
  if (unreadable.length > 0) {
    return {
      decision: 'refuse-unreadable-segment',
      reason: `segment(s) ${unreadable.sort().join(', ')} have an unreadable or malformed first entry, so their branch cannot be determined — they can be neither listed as candidates nor safely excluded from the choice; repair them first`,
      branch,
    };
  }
  const mine = valid.filter((name) => parsedByName.get(name)?.first?.branch === branch);

  if (segment === null) {
    return { decision: 'list', branch, candidates: mine.map((name) => describeCandidate(name, parsedByName.get(name), key, allowChainOnly)) };
  }

  // Named adoption. `valid` membership is the grammar/traversal check: a name
  // that discoverSegments did not classify as a real segment of THIS store
  // is never openable, so path escapes and malformed names refuse here.
  if (!valid.includes(segment) || !existsSync(segmentPath(dir, segment))) {
    return { decision: 'refuse-unknown-segment', reason: `no segment named ${segment} exists in this store`, branch, candidates: mine.map((name) => describeCandidate(name, parsedByName.get(name), key, allowChainOnly)) };
  }
  if (!mine.includes(segment)) {
    const declared = parsedByName.get(segment)?.first?.branch ?? null;
    return { decision: 'refuse-wrong-branch', reason: `segment ${segment} declares branch ${JSON.stringify(declared)}, not ${JSON.stringify(branch)} — adopting it would bind this checkout to a different lineage`, branch };
  }
  if (!authenticate(parsedByName.get(segment), key, allowChainOnly)) {
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
