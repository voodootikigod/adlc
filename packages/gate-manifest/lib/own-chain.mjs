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
// cannot read the whole forest. This reader walks the anchor graph UPWARD from
// this checkout's own segment to root and returns that ancestry, oldest first:
//
//   root prefix → … → grandparent → parent → own segment
//
// Every chain is cut at the seq its CHILD anchored into (spec §4.4: an anchor
// names the exact line it forked from). Entries beyond that point were appended
// after the fork, so they are concurrent with the child, not before it. With
// the frozen root every segment in this repo anchors at the root tip and the
// truncation never fires — it exists so the "array position is causal" claim
// holds for a repo where it would.
//
// UNRELATED segments — anything not on that ancestry path — are not read at
// all. Their evidence is not "resolved" or "unresolved" for this chain; it
// belongs to a prosecution this checkout is not running, and the branch that
// owns it reads it as ITS own chain.
//
// ANCESTRY IS WALKED, NOT ASSUMED FLAT (adversarial-review, distinct provider,
// round 1). An earlier version kept the whole of root and the own segment, and
// justified dropping an intermediate parent as "conservative". It is not:
// keeping root's `p5-complete` while dropping a parent segment's still-open
// finding is a FALSE PASS, not a cautious one. Conservatism only holds when
// evidence is dropped in both directions at once, which a partial ancestry does
// not do.
//
// "CANNOT DETERMINE" IS NEVER "NOTHING IS THERE" (same review, round 1). The
// detached HEAD a CI checkout normally sits in has no branch identity, and
// `recoverOpenSegment` returns null there rather than throwing — indistinguish-
// able, to a caller that only catches, from "this branch has no segment". That
// silently collapsed a segmented ledger to root-only in exactly the environment
// the gates run in. Every unresolvable case now returns `identityError` and NO
// entries; `@adlc/tickets`' readOwnChains refuses on the identical condition.
//
// It stays a LENIENT read of entry CONTENT, like `readManifestForest` and
// unlike `readOwnChains`: trust decisions belong to `verify()`, run separately.
// The refusals here are about IDENTITY and ANCESTRY — which entries are ours —
// never about whether their content verifies.

import { ADLC_DIR } from '@adlc/core';
import { discoverSegments, readManifestForest } from './forest.mjs';
import { currentBranch, recoverOpenSegment } from './lineage.mjs';

/**
 * This checkout's own causal chain: root's prior prefix, then each ancestor
 * segment cut at its child's fork point, then the own segment.
 *
 * @param {string} [dir]  ledger directory (default ADLC_DIR)
 * @param {{cwd?: string}} [opts]  `cwd` locates the git checkout whose branch
 *   identifies "our own" segment.
 * @returns {{entries: object[], skipped: object[], ownSegment: string|null,
 *   identityError: string|null}}  When `identityError` is set, `entries` is
 *   EMPTY and the same message is appended to `skipped`. Two channels because
 *   the consumers refuse differently: assertPhase already treats a non-empty
 *   `skipped` as "do not pass" (`ok: … && skipped.length === 0`), while
 *   prosecute and acceptance read `identityError` and return an error before
 *   writing anything. Empty entries is the belt to that braces — a consumer
 *   that forgets to check still cannot read a stale completion as ours.
 */
export function readOwnManifestChain(dir = ADLC_DIR, { cwd = process.cwd() } = {}) {
  const { entries, skipped } = readManifestForest(dir);
  const inSegment = (name) => entries.filter((entry) => entry.segment === name);

  const refuse = (reason) => {
    const identityError = `cannot establish this checkout's own causal chain: ${reason}`;
    return {
      entries: [],
      skipped: [...skipped, { segment: null, line: null, error: identityError }],
      ownSegment: null,
      identityError,
    };
  };

  const segments = discoverSegments(dir).valid;

  // Checked BEFORE recoverOpenSegment, because that function answers this case
  // with `null` — the same value it uses for the genuinely benign "this branch
  // simply has no segment yet". A catch cannot tell them apart, so the
  // distinction has to be drawn here.
  if (segments.length > 0 && currentBranch(cwd) === null) {
    return refuse(
      'detached HEAD has no branch identity to recover by, and committed segments exist '
      + '— refusing to treat them as absent'
    );
  }

  let own = null;
  try {
    // Consults the local `.lineage` token first (peekOpenSegment), then falls
    // back to the exact `branch` field every segment's first entry carries.
    // The fallback is what keeps this working in CI, where `.lineage` is
    // gitignored (spec §7 point 1). It never mints and never guesses among
    // candidates — it throws instead.
    own = recoverOpenSegment(dir, { cwd });
  } catch (err) {
    return refuse(err.message);
  }

  // A branch we could identify that owns no segment: root is the whole of our
  // chain, and nothing was forked from, so there is no prefix to cut.
  if (own === null) return { entries: inSegment('root'), skipped, ownSegment: null, identityError: null };

  const firstOf = new Map(segments.map((name) => [name, entries.find((entry) => entry.segment === name)]));

  // Walk own → parent → … → root, remembering the seq each hop's CHILD forked
  // at so the hop can be cut there on the way back down.
  const hops = []; // own first; `bound` is the child's fork seq, null for own itself
  const seen = new Set();
  let cursor = own.name;
  let childBound = null;
  let rootBound = null;
  let reachedRoot = false;
  for (;;) {
    if (seen.has(cursor)) return refuse(`anchor cycle through segment '${cursor}'`);
    seen.add(cursor);
    hops.push({ name: cursor, bound: childBound });

    const first = firstOf.get(cursor);
    if (first === undefined) return refuse(`segment '${cursor}' has no readable first entry, so its anchor cannot be resolved`);

    const anchor = first.anchor;
    // `anchor: null` is a rootless segment (§4.4) — nothing in root precedes
    // it, so root is left out entirely rather than assumed prior. A first entry
    // carrying no `anchor` key at all is read the same way readManifestForest
    // reads it, rather than inventing a stricter rule here.
    if (anchor === null || anchor === undefined) break;
    if (typeof anchor !== 'object' || Array.isArray(anchor) || typeof anchor.segment !== 'string' || !Number.isInteger(anchor.seq)) {
      return refuse(`segment '${cursor}' has a malformed anchor, so its ancestry cannot be established`);
    }
    if (anchor.segment === 'root') { rootBound = anchor.seq; reachedRoot = true; break; }
    if (!firstOf.has(anchor.segment)) {
      return refuse(`segment '${cursor}' anchors to '${anchor.segment}', which is not a segment in this forest`);
    }
    childBound = anchor.seq;
    cursor = anchor.segment;
  }

  const upTo = (list, bound) => (bound === null ? list : list.filter((entry) => seqOf(entry) === null || seqOf(entry) <= bound));

  const chain = reachedRoot ? [...upTo(inSegment('root'), rootBound)] : [];
  for (const hop of [...hops].reverse()) chain.push(...upTo(inSegment(hop.name), hop.bound));

  return { entries: chain, skipped, ownSegment: own.name, identityError: null };
}

function seqOf(entry) {
  return Number.isInteger(entry?.seq) ? entry.seq : null;
}
