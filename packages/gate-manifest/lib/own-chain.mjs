// own-chain.mjs — the subset of the forest whose ARRAY POSITION is a causal
// order, for the P5 gate consumers that compare entries by position.
//
// `readManifestForest` orders segments by anchor topology (anchored-to
// segment, anchored-to seq, own ULID) so `show`/`attest` render the same
// forest the same way everywhere. Its own header says, in as many words, that
// this is deliberately NOT a causal or temporal order across independent
// segments — two branches that mint segments the same afternoon land in
// whatever order their ULIDs sort, which says nothing about which evidence
// came first. Nothing across independent segments can say: they are concurrent
// by construction, and no single branch can observe an order between them.
//
// Consumers that must answer "latest", "before", or "already killed" therefore
// cannot read the whole forest. This reader hands back only the entries this
// checkout can honestly place in sequence:
//
//   1. the root chain's entries, in seq order, up to and including the seq
//      this checkout's own segment anchors at — every one of them is provably
//      prior to every entry in that segment (spec §4.4: a segment's anchor
//      names the exact root line it forked from);
//   2. this checkout's own open segment's entries, in seq order.
//
// Root entries BEYOND the anchor are dropped rather than assumed prior: they
// were appended after this segment forked, so they are concurrent with it, not
// before it. With the frozen root every segment in this repo anchors at the
// root tip, so that prefix is the whole of root and the truncation never
// fires — it exists so the "array position is causal" claim holds for a repo
// where it would.
//
// UNRELATED segments are not read at all. Their evidence is not "resolved" or
// "unresolved" for this chain; it belongs to a prosecution this checkout is not
// running, and the branch that owns it reads it as ITS own chain. Dropping it
// is conservative in both directions the two consumers care about: assertPhase
// sees less evidence and so cannot pass on it, and prosecute seeds fewer
// killed-findings and so leaves more findings open.
//
// This is the `readOwnChains`/`peekOpenSegment` scoping `@adlc/tickets`'
// doctor, and ticket-sync's reassign and push, already apply for the same
// reason. It stays a LENIENT read, like `readManifestForest` and unlike
// `readOwnChains`: trust decisions belong to `verify()`, run separately, and
// these callers report rather than throw.

import { ADLC_DIR } from '@adlc/core';
import { readManifestForest } from './forest.mjs';
import { recoverOpenSegment } from './lineage.mjs';

/**
 * Root's causally-prior prefix plus this checkout's own open segment, in an
 * order whose array position IS a causal order.
 *
 * @param {string} [dir]  ledger directory (default ADLC_DIR)
 * @param {{cwd?: string}} [opts]  `cwd` locates the git checkout whose branch
 *   identifies "our own" segment.
 * @returns {{entries: object[], skipped: object[], ownSegment: string|null,
 *   identityError: string|null}}  `skipped` carries everything
 *   `readManifestForest` reports, plus one record whenever `identityError` is
 *   set. Both channels exist because the two consumers refuse differently:
 *   assertPhase already treats a non-empty `skipped` as "do not pass"
 *   (`ok: … && skipped.length === 0`), while prosecute has no `skipped`
 *   channel and reads `identityError` to return an op-error before its first
 *   append. Neither may read an unidentifiable checkout as "no evidence".
 */
export function readOwnManifestChain(dir = ADLC_DIR, { cwd = process.cwd() } = {}) {
  const { entries, skipped } = readManifestForest(dir);

  let own = null;
  try {
    // recoverOpenSegment consults the local `.lineage` token first
    // (peekOpenSegment) and falls back to the exact `branch` field every
    // segment's first entry carries. The fallback is what keeps this working
    // in CI, where `.lineage` is gitignored (spec §7 point 1) and a token-only
    // lookup would report "no segment of ours" for a branch whose committed
    // segment is sitting right there. It never mints and never guesses among
    // candidates — it throws instead, which is the case below.
    own = recoverOpenSegment(dir, { cwd });
  } catch (err) {
    // Two committed segments both claiming this branch, or a non-conforming
    // object in manifest.d/ that could be a disguised one. Either way we
    // cannot say which entries are ours, and "cannot determine" must not read
    // as "there is nothing" — that is the shape an attacker would use to
    // strand a verified finding in one segment and complete P5 from another.
    const identityError = `cannot identify this checkout's own segment: ${err.message}`;
    return {
      entries: entries.filter((entry) => entry.segment === 'root'),
      skipped: [...skipped, { segment: null, line: null, error: identityError }],
      ownSegment: null,
      identityError,
    };
  }

  const ownName = own?.name ?? null;
  const anchorSeq = ownName === null ? null : rootAnchorSeq(entries, ownName);
  const rootPrefix = entries.filter((entry) =>
    entry.segment === 'root' && (anchorSeq === null || seqOf(entry) === null || seqOf(entry) <= anchorSeq)
  );
  const ownEntries = ownName === null ? [] : entries.filter((entry) => entry.segment === ownName);

  return { entries: [...rootPrefix, ...ownEntries], skipped, ownSegment: ownName, identityError: null };
}

function seqOf(entry) {
  return Number.isInteger(entry?.seq) ? entry.seq : null;
}

/**
 * The root seq our own segment forked at, or null when it does not fork from
 * root at all (an `anchor: null` rootless segment, or one anchored to another
 * segment — §4.4 permits both). Null means "no root prefix to bound", so the
 * whole of root is kept: for a rootless segment root is empty anyway, and for
 * a segment-anchored one the chain back to root is longer than this reader
 * claims to walk, so keeping root whole stays on the conservative side of the
 * two consumers rather than inventing a bound.
 */
function rootAnchorSeq(entries, ownName) {
  const first = entries.find((entry) => entry.segment === ownName);
  const anchor = first?.anchor;
  if (!anchor || typeof anchor !== 'object' || anchor.segment !== 'root') return null;
  return Number.isInteger(anchor.seq) ? anchor.seq : null;
}
