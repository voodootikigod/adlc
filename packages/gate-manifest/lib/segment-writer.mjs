// segment-writer.mjs — the locked append path for a segmented repo
// (T-MANIFEST-FOREST slice 3, docs/specs/segmented-gate-manifest.md §7).
// record.mjs's appendManifestEntry routes here once lineage.mjs's
// isSegmentedRepo(dir) is true.

import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256, withLedgerLock } from '@adlc/core';
import { signEntry } from './sign.mjs';
import { verify } from './verify.mjs';
import { segmentPath, segmentDirPath } from './forest.mjs';
import { resolveOpenSegment, lineagePath } from './lineage.mjs';

/**
 * Append `payload` to the current lineage's segment, minting a new one when
 * needed (spec §7.1). Caller (record.mjs) has already validated `payload`
 * carries none of the reserved chain fields, including `anchor`, and has
 * already resolved `key` via validateKeyParam. Not a public entry point —
 * record.mjs's appendManifestEntry is, and it always resolves
 * `dir`/`signatureVersion`/`cwd`/`key` itself before calling here, so this
 * takes no defaults of its own (an unreachable default is untestable dead
 * code).
 */
export function appendToSegment(payload, dir, { signatureVersion, cwd, key }) {
  // Adversarial-review finding: resolving the open segment (reading/minting
  // against .lineage) and actually writing to it used to be UNSYNCHRONIZED
  // with each other. Two first-ever writers on the same branch could both
  // observe no usable token, mint DIFFERENT segments, and both succeed —
  // there is no per-segment lock to serialize on until a segment is chosen,
  // so spec §7's "concurrent writers in one checkout serialize on the
  // segment lock" silently didn't hold for the very first write. A
  // checkout-wide lock on .lineage itself — the one thing every writer here
  // reads before deciding a target — makes resolution AND the eventual
  // write one atomic transaction per checkout. The per-segment lock below
  // stays too: it protects the segment's bytes against anything that might
  // ever write to it directly, not only writers that go through
  // resolveOpenSegment.
  //
  // The callback is a NAMED function, not inline (mutation-gate operator
  // limitation, #293): a mutation replacing this multi-line `return X` with
  // `return null` left dangling braces behind and never parsed, so the
  // segment-writer's own locking precondition had no mutation coverage at
  // the default CI budget. A single-line return of a named function call
  // mutates cleanly.
  return withLedgerLock(lineagePath(dir), () => appendWithinLedgerLock(payload, dir, { signatureVersion, cwd, key }));
}

// The chain-integrity check (verify()) MUST run INSIDE the .lineage lock, not
// before it (a second adversarial-review finding on the first version of this
// fix): openSync(path, 'a') creates a segment's file the instant a writer
// starts publishing its FIRST line, before that line is actually written — a
// transient, genuinely-empty segment on disk. A second writer whose verify()
// ran OUTSIDE the lock could observe exactly that instant, see an anchorless
// empty segment, and fail the whole forest instead of simply blocking on the
// lock like it should. Checking only after the lock is held means a queued
// writer only ever observes a FINISHED publish, never a transient one.
function appendWithinLedgerLock(payload, dir, { signatureVersion, cwd, key }) {
  const integrity = verify(dir, { requireSignatures: false, key });
  if (!integrity.valid) {
    throw new Error(`manifest forest is invalid: ${integrity.message}`);
  }
  const resolved = resolveOpenSegment(dir, { cwd, key });
  const targetPath = segmentPath(dir, resolved.name);
  mkdirSync(segmentDirPath(dir), { recursive: true });
  return withLedgerLock(targetPath, () => appendLockedEntry(payload, resolved, targetPath, signatureVersion, key));
}

function appendLockedEntry(payload, resolved, targetPath, signatureVersion, key) {
  const content = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  const rawLines = content.split('\n').filter((line) => line.trim() !== '');
  if (resolved.isNew && rawLines.length > 0) {
    // resolveOpenSegment decided this file doesn't exist yet; if it now does
    // (ULID collision, or a corrupted lineage token pointed at a name that
    // happens to be real), appending as though it were empty would silently
    // skip the anchor requirement and misnumber seq — fail loud instead.
    throw new Error(`segment ${resolved.name} was expected to be new but already has content — refusing to append`);
  }
  if (!resolved.isNew && rawLines.length === 0) {
    // The mirror case (adversarial-review finding): resolveOpenSegment
    // resolved to an EXISTING, already-open segment (outside this lock),
    // but by the time this lock is held the file is empty or gone — some
    // operator action, or a concurrent process, removed it between
    // resolution and this append. Silently treating that as "start fresh"
    // would write seq:1 WITHOUT the required anchor (isNew is false, so no
    // anchor is added), producing a segment verify() rejects outright.
    // Refuse instead: a real re-mint must go through resolveOpenSegment
    // again, which will correctly mark it isNew and supply an anchor.
    throw new Error(`segment ${resolved.name} was expected to already be open with content but is empty or missing — refusing to append without an anchor`);
  }
  const entries = rawLines.map((line, i) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`segment ${resolved.name} contains malformed JSON at line ${i + 1}`); }
  });
  const previous = entries.at(-1) ?? null;
  if (previous && (!Number.isInteger(previous.seq) || previous.seq < 1)) {
    throw new Error(`segment ${resolved.name} tail is not hash-chain compatible: missing positive seq`);
  }
  const prevRawLine = rawLines.at(-1) ?? null;

  const normalized = {
    ...payload,
    gate: payload.gate ?? payload.type ?? 'evidence',
    ts: payload.ts ?? new Date().toISOString(),
    files: payload.files ?? {},
  };
  const chained = {
    seq: previous ? previous.seq + 1 : 1,
    ...normalized,
    // `anchor`/`branch` spread AFTER `...normalized`, not before (adversarial-
    // review finding, T-MANIFEST-FOREST fourth round): `RESERVED_CHAIN_FIELDS`
    // in record.mjs already rejects a payload that supplies either field
    // outright, but constructing these writer-owned structural fields LAST is
    // defense-in-depth — a payload can never overwrite them regardless of
    // what upstream validation does or doesn't catch. `branch` is the EXACT
    // git branch that minted this segment, recorded once on the first entry
    // alongside `anchor` — a non-lossy identity recoverOpenSegment matches on,
    // unlike the derived filename slug (see lineage.mjs's recoverOpenSegment
    // doc). Omitted (not `anchor`-style `null`) when resolveOpenSegment minted
    // this segment from a detached HEAD, which has no branch identity.
    ...(resolved.isNew ? { anchor: resolved.anchor, ...(resolved.branch !== undefined ? { branch: resolved.branch } : {}) } : {}),
    prev: prevRawLine === null ? null : sha256(prevRawLine),
  };

  // spec §4.4: the anchor is tamper-evident only under v2 (v2 signs every
  // field the entry carries; v1's fixed field set predates segments and
  // never included `anchor`). Force v2 whenever this entry carries one,
  // regardless of what the caller requested, so an anchor is never
  // silently left unsigned by a caller that still asks for v1 (e.g.
  // record()'s CLI path).
  const effectiveSignatureVersion = resolved.isNew ? 2 : signatureVersion;
  if (key) {
    if (effectiveSignatureVersion === 2) chained.sigVersion = 2;
    chained.sig = signEntry(key, chained);
  }

  const fd = openSync(targetPath, 'a');
  try {
    writeFileSync(fd, `${JSON.stringify(chained)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') {
    const dirFd = openSync(dirname(targetPath), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }
  return chained;
}
