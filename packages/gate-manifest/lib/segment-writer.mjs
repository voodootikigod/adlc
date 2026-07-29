// segment-writer.mjs — the locked append path for a segmented repo
// (T-MANIFEST-FOREST slice 3, docs/specs/segmented-gate-manifest.md §7).
// record.mjs's appendManifestEntry routes here once lineage.mjs's
// isSegmentedRepo(dir) is true.

import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256, withLedgerLock } from '@adlc/core';
import { getKey, signEntry } from './sign.mjs';
import { verify } from './verify.mjs';
import { segmentPath, segmentDirPath } from './forest.mjs';
import { resolveOpenSegment, lineagePath } from './lineage.mjs';

/**
 * Append `payload` to the current lineage's segment, minting a new one when
 * needed (spec §7.1). Caller (record.mjs) has already validated `payload`
 * carries none of the reserved chain fields, including `anchor`. Not a public
 * entry point — record.mjs's appendManifestEntry is, and it always resolves
 * `dir`/`signatureVersion`/`cwd` itself before calling here, so this takes no
 * defaults of its own (an unreachable default is untestable dead code).
 */
export function appendToSegment(payload, dir, { signatureVersion, cwd }) {
  // Same chain-integrity precondition root append already enforces (record.mjs's
  // "we must not append onto a corrupted/unchained tail"), forest-wide: a
  // corrupted segment or a dangling/cyclic anchor must block every writer, not
  // just readers.
  const integrity = verify(dir, { requireSignatures: false });
  if (!integrity.valid) {
    throw new Error(`manifest forest is invalid: ${integrity.message}`);
  }

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
  return withLedgerLock(lineagePath(dir), () => {
    const resolved = resolveOpenSegment(dir, { cwd });
    const targetPath = segmentPath(dir, resolved.name);
    mkdirSync(segmentDirPath(dir), { recursive: true });
    return withLedgerLock(targetPath, () => appendLockedEntry(payload, resolved, targetPath, signatureVersion));
  });
}

function appendLockedEntry(payload, resolved, targetPath, signatureVersion) {
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
    ...(resolved.isNew ? { anchor: resolved.anchor } : {}),
    ...normalized,
    prev: prevRawLine === null ? null : sha256(prevRawLine),
  };

  const key = getKey();
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
