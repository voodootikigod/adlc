// reassign.mjs — id reassignment on create/transfer (design D8/D9). When a local
// `T<n>` ticket is created on the tracker it gets the gh-qualified id; a
// transferred/renumbered issue likewise changes its `gh:` id string. Both must
// rewrite EVERY edge that pointed at the old id (single id space → no dangling
// edges) and carry the ticket's prior gate evidence forward.
//
// Manifest evidence migration is **append-only re-attestation**, NOT an in-place
// rewrite. `.adlc/manifest.jsonl` is a hash-chained, optionally HMAC-signed
// append-only ledger: editing a past entry's `ticket` field would invalidate the
// `prev` chain of every later line and break any `sig`. Instead we APPEND new
// entries that re-bind the old id's latest-per-gate evidence to the new id, with
// a correct chain link and (when a key is set) a fresh signature. `outcomes.mjs`
// reduces latest-per-gate by ticket id, so the new id inherits the status without
// touching history. (Display-only evidence; the ledger stays tamper-evident.)

import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac } from 'node:crypto';
import { appendEntries, sha256 } from '@adlc/core';
import {
  isSegmentedRepo, resolveOpenSegment, readOwnChains, forestChainsIntact,
  segmentPath, lineagePath, withManifestLock, canonicalJson, entrySigValid,
  validateKeyParam,
} from '@adlc/tickets';

/**
 * Reassign one ticket id store-wide (pure, immutable). Returns a NEW ticket array
 * where the ticket whose id === oldId is renamed to newId AND every `edges[].to`
 * equal to oldId (in any ticket) is rewritten to newId. Nothing else changes.
 */
export function reassignId(tickets, oldId, newId) {
  return tickets.map((t) => {
    const sameId = t.id === oldId;
    const hasEdge = Array.isArray(t.edges) && t.edges.some((e) => e?.to === oldId);
    if (!sameId && !hasEdge) return t;
    const next = { ...t };
    if (sameId) next.id = newId;
    if (Array.isArray(t.edges)) next.edges = t.edges.map((e) => (e?.to === oldId ? { ...e, to: newId } : e));
    return next;
  });
}

/**
 * Plan the manifest re-attestation: the latest-per-gate entries currently bound
 * to `oldId` are the evidence to carry forward. Pure (no I/O). Latest wins per
 * gate so a re-attestation never resurrects a superseded verdict.
 *
 * `input` is either a flat array of entries from ONE chain (plain `seq`
 * comparison decides "latest", robust to entries arriving out of array
 * order), or — for T-MANIFEST-FOREST's readOwnChains — an array of chains in
 * causal order (root first, at most one segment last). Chain identity is
 * required, not inferred from position: each chain restarts `seq` at 1, so a
 * later chain's entry ALWAYS outranks an earlier chain's for the same gate
 * regardless of the seq values involved (adversarial-review finding: a stale
 * root approval at a high seq must never outrank a causally-later segment
 * rejection at a low one); only entries already known to be from the SAME
 * chain are compared by seq.
 *
 * `key`, when provided (adversarial-review finding): a candidate source must
 * carry a valid signature to be re-attested — forestChainsIntact's per-chain
 * legacy-unsigned-prefix tolerance (needed so an honest chain that predates
 * signing can still verify) is NOT enough on its own to authenticate ONE
 * entry as genuine. Without this, a wholly-unsigned forged segment (passes
 * the chain-wide check by design — indistinguishable from an honest chain
 * that predates signing) could supply a forged verdict that this function
 * then signs FRESH under the new id, laundering it into a validly
 * HMAC-signed attestation nobody with the key ever actually approved.
 * @returns {Array<object>} source entries (one per gate) to re-attest under newId
 */
export function planManifestMigration(input, oldId, newId = null, key = null) {
  const chains = Array.isArray(input?.[0]) ? input : [input ?? []];
  const latestByGate = new Map(); // gate -> { entry, chainIndex }
  chains.forEach((chain, chainIndex) => {
    for (const e of chain ?? []) {
      if (!e || e.ticket !== oldId || typeof e.gate !== 'string') continue;
      if (key !== null && !entrySigValid(key, e)) continue;
      const prev = latestByGate.get(e.gate);
      const wins = !prev || chainIndex > prev.chainIndex
        || (chainIndex === prev.chainIndex && (typeof e.seq === 'number' ? e.seq : 0) >= (typeof prev.entry.seq === 'number' ? prev.entry.seq : 0));
      if (wins) latestByGate.set(e.gate, { entry: e, chainIndex });
    }
  });
  const sources = [...latestByGate.values()].map((v) => v.entry);
  if (!newId) return sources;
  const allEntries = chains.flat();
  return sources.filter((source) => {
    const sourceHash = sha256(JSON.stringify(source));
    return !allEntries.some((entry) => entry?.ticket === newId
      && entry?.gate === source.gate
      && entry?.data?.migratedFrom === oldId
      && (entry.data.migratedEvidenceHash === sourceHash || legacyReattestationMatches(entry, source)));
  });
}

function legacyReattestationMatches(entry, source) {
  if (entry.data?.migratedEvidenceHash !== undefined) return false;
  const data = { ...(entry.data ?? {}) };
  delete data.migratedFrom;
  return JSON.stringify(data) === JSON.stringify(source.data ?? {})
    && JSON.stringify(entry.files ?? {}) === JSON.stringify(source.files ?? {});
}

// Mirror of @adlc/gate-manifest sign.mjs canonicalEntryBytes (v1) — the signed
// payload is { seq, gate, ts, ticket?, data?, files, prev } in this fixed key
// order, sig excluded. Kept local (zero cross-package coupling); pinned by a test.
function canonicalEntryBytes(entry) {
  const c = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== undefined) c.ticket = entry.ticket;
  if (entry.data !== undefined) c.data = entry.data;
  c.files = entry.files;
  c.prev = entry.prev;
  return JSON.stringify(c);
}

// v2 signing (all fields except sig/segment, canonically sorted) — required
// for a segment's anchor-carrying first entry (spec §4.4: v1's fixed field
// set never covers `anchor`). Mirrors @adlc/gate-manifest/lib/sign.mjs.
function signV2(key, entry) {
  const { sig: _sig, segment: _segment, ...signed } = entry;
  return createHmac('sha256', key).update(canonicalJson(signed)).digest('hex');
}

// Build the re-attestation entries for one contiguous append (root OR one
// segment). `firstAnchor`, when provided, marks this as a brand-new segment's
// first entry: it carries `anchor` (and `firstBranch`, when the mint had a
// resolvable branch identity) and is forced to sign at v2.
function buildReattestationEntries(sources, { oldId, newId, now, key, startSeq, startPrev, firstAnchor, firstBranch }) {
  let prev = startPrev;
  let seq = startSeq;
  const additions = [];
  sources.forEach((src, index) => {
    seq += 1;
    const carriesAnchor = index === 0 && firstAnchor !== undefined;
    const entry = {
      seq,
      // `branch` (T-MANIFEST-FOREST, fourth round): the EXACT git branch that
      // minted this segment, alongside `anchor` — the non-lossy identity
      // recoverOpenSegment matches on. Mirrors segment-writer.mjs/evidence.mjs's
      // identical addition.
      ...(carriesAnchor ? { anchor: firstAnchor, ...(firstBranch !== undefined ? { branch: firstBranch } : {}) } : {}),
      gate: src.gate,
      ts: now,
      ticket: newId,
      data: { ...(src.data ?? {}), migratedFrom: oldId, migratedEvidenceHash: sha256(JSON.stringify(src)) },
      files: src.files ?? {},
      prev,
    };
    if (key) {
      if (carriesAnchor) {
        entry.sigVersion = 2;
        entry.sig = signV2(key, entry);
      } else {
        entry.sig = createHmac('sha256', key).update(canonicalEntryBytes(entry)).digest('hex');
      }
    }
    additions.push(entry);
    prev = sha256(JSON.stringify(entry));
  });
  return additions;
}

/**
 * Append-only re-attestation, once segmented (T-MANIFEST-FOREST). Mirrors
 * @adlc/tickets' own recordSegmentedTicketEvidence: checkout-wide .lineage
 * lock around resolution AND the write, chain-integrity precondition, and
 * refusal to silently treat a stale/emptied target segment as fresh.
 */
function migrateSegmentedSet(adlcDir, oldId, newId, { now, key, cwd }) {
  return withManifestLock(lineagePath(adlcDir), () => {
    // `key` also enforces per-chain signature validity, not just the hash chain
    // (adversarial-review finding, T-MANIFEST-FOREST): without it, a forged,
    // correctly-chained-but-unsigned entry could be trusted as a genuine
    // re-attestation source even with signing configured.
    if (!forestChainsIntact(adlcDir, { key })) {
      throw new Error('cannot re-attest evidence: manifest forest is invalid — a segment or root chain is broken, or an entry is unsigned/forged');
    }
    // readOwnChains's allowRecovery: true (T-MANIFEST-FOREST, fourth round —
    // supersedes the round-2/round-3 strict-only reasoning below) lets this
    // re-sign whatever it finds as a FRESH, newly-signed re-attestation under
    // the new id even when this checkout's own `.lineage` token is lost
    // (fresh clone, or a branch switch that overwrote it). Earlier rounds kept
    // this strict because the OLD recoverOpenSegment matched on the derived
    // filename slug — a LOSSY, caller-controlled identity that could launder
    // an unrelated lineage's evidence into a validly-signed entry nobody with
    // the key actually approved for THIS ticket. recoverOpenSegment now
    // matches on the EXACT `branch` field every segment's first entry carries
    // (spec §4.4) — non-lossy — but exact identity is not authenticity
    // (adversarial-review finding, round 2): `key` is passed through so
    // readOwnChains filters recovered entries to only signature-verified ones,
    // and disables recovery entirely without a key (see readOwnChains's own
    // doc). `planManifestMigration` below ALSO independently re-checks
    // entrySigValid on every candidate it re-attests — belt-and-suspenders,
    // not redundant: it is what protects reads that bypass this call
    // entirely (root, or a token-matched non-recovered segment).
    //
    // A genuinely AMBIGUOUS recovery (two committed segments both declaring
    // this branch — e.g. a token lost mid-stream, then a second mint)
    // propagates as a real thrown error here rather than silently treating it
    // as "nothing to migrate" — proceeding with the ID rewrite anyway would
    // strand real evidence under the abandoned old id forever.
    const sources = planManifestMigration(readOwnChains(adlcDir, { cwd, allowRecovery: true, key }), oldId, newId, key);
    if (sources.length === 0) return [];

    // `key` must reach the resolver (adversarial-review finding): the read
    // above recovers the committed segment WITH the key, so a keyless
    // resolver call here would skip recovery, mint a duplicate segment, and
    // write its token — hiding the just-recovered evidence from every later
    // branch-local read, the exact bug write-side recovery exists to close.
    const resolved = resolveOpenSegment(adlcDir, { cwd, key });
    const targetPath = segmentPath(adlcDir, resolved.name);
    mkdirSync(dirname(targetPath), { recursive: true });
    return withManifestLock(targetPath, () => {
      const content = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
      const rawLines = content.split('\n').filter((line) => line.trim() !== '');
      if (resolved.isNew && rawLines.length > 0) {
        throw new Error(`segment ${resolved.name} was expected to be new but already has content`);
      }
      if (!resolved.isNew && rawLines.length === 0) {
        throw new Error(`segment ${resolved.name} was expected to already be open with content but is empty or missing`);
      }
      let previous = null;
      for (const line of rawLines) {
        try { previous = JSON.parse(line); } catch { throw new Error(`segment ${resolved.name} contains malformed JSON`); }
      }
      const prevRawLine = rawLines.at(-1) ?? null;
      const additions = buildReattestationEntries(sources, {
        oldId, newId, now, key,
        startSeq: previous ? previous.seq : 0,
        startPrev: prevRawLine === null ? null : sha256(prevRawLine),
        firstAnchor: resolved.isNew ? resolved.anchor : undefined,
        firstBranch: resolved.isNew ? resolved.branch : undefined,
      });
      const lines = additions.map((entry) => `${JSON.stringify(entry)}\n`).join('');
      const fd = openSync(targetPath, 'a');
      try {
        writeFileSync(fd, lines);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      return additions;
    });
  });
}

/**
 * Append-only re-attestation of `oldId`'s evidence under `newId`.
 *
 * @param {string} dir         repo root (manifest lives at <dir>/.adlc/manifest.jsonl)
 * @param {string} oldId
 * @param {string} newId
 * @param {object} opts
 * @param {string} opts.now    ISO timestamp for the new entries
 * @param {string|null} opts.key  signing key (validateKeyParam); resolved by the caller, never read from env here
 * @param {Function} [opts.appendBatch] injectable ownership-safe batch appender
 * @returns {{ migrated: number, entries: object[] }}
 */
export function migrateManifestEvidence(dir, oldId, newId, { now, key: keyParam, appendBatch = appendEntries } = {}) {
  const adlcDir = `${dir}/.adlc`;
  const key = validateKeyParam(keyParam); // required: an omitted key is a caller bug, never an env read at library depth

  // T-MANIFEST-FOREST (adversarial-review finding): this writer used to call
  // core's appendEntries directly on root unconditionally. Post-cutover that
  // both appends behind the frozen root AND makes manifest-cutover cease to
  // be root's tail — defeating isSegmentedRepo's fallback signal if the
  // activation marker is later lost.
  if (isSegmentedRepo(adlcDir)) {
    const out = migrateSegmentedSet(adlcDir, oldId, newId, { now, key, cwd: dir });
    return { migrated: out.length, entries: out };
  }

  const out = appendBatch('manifest', ({ entries, skipped, lastRawLine }) => {
    if (skipped.length) throw new Error(`cannot re-attest evidence: manifest contains malformed line ${skipped[0].line}`);
    const sources = planManifestMigration(entries, oldId, newId, key);
    const startPrev = lastRawLine !== null ? sha256(lastRawLine) : null;
    const startSeq = entries.length ? Math.max(...entries.map((e) => (typeof e.seq === 'number' ? e.seq : 0))) : 0;
    return buildReattestationEntries(sources, { oldId, newId, now, key, startSeq, startPrev });
  }, adlcDir);
  return { migrated: out.length, entries: out };
}
