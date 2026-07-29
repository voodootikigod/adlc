// segment-writer.mjs — the locked append path for a segmented repo
// (T-MANIFEST-FOREST slice 3, docs/specs/segmented-gate-manifest.md §7).
// record.mjs's appendManifestEntry routes here once lineage.mjs's
// isSegmentedRepo(dir) is true; root's own append path is untouched and
// unreachable once segmented (§7 point 3 — "MUST refuse to append to root" —
// is enforced structurally: this module is the only thing that runs).

import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256, withLedgerLock } from '@adlc/core';
import { getKey, signEntry } from './sign.mjs';
import { verify } from './verify.mjs';
import { segmentPath, segmentDirPath } from './forest.mjs';
import { resolveOpenSegment } from './lineage.mjs';

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

  const resolved = resolveOpenSegment(dir, { cwd });
  const targetPath = segmentPath(dir, resolved.name);
  mkdirSync(segmentDirPath(dir), { recursive: true });

  return withLedgerLock(targetPath, () => {
    const content = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
    const rawLines = content.split('\n').filter((line) => line.trim() !== '');
    if (resolved.isNew && rawLines.length > 0) {
      // resolveOpenSegment decided this file doesn't exist yet; if it now does
      // (ULID collision, or a corrupted lineage token pointed at a name that
      // happens to be real), appending as though it were empty would silently
      // skip the anchor requirement and misnumber seq — fail loud instead.
      throw new Error(`segment ${resolved.name} was expected to be new but already has content — refusing to append`);
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
  });
}
