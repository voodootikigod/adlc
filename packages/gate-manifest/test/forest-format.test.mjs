// forest-format.test.mjs — golden fixtures for the chain-forest read layer
// (docs/specs/segmented-gate-manifest.md §4-§5, spec AC1 + part of AC2).
//
// Segments are hand-built here (JSONL written directly, chained/signed with
// sign.mjs) rather than via appendManifestEntry: the segment WRITER is a
// later slice (T-MANIFEST-FOREST slice 3) — this suite only exercises the
// reader (verify/forest.mjs), which must accept whatever a conforming writer
// would have produced and reject whatever it wouldn't.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verify as realVerify } from '../lib/verify.mjs';
import { discoverSegments, resolveAnchor, detectAnchorCycle, readManifestForest } from '../lib/forest.mjs';
import { renderEntry } from '../lib/show.mjs';
import { sha256 } from '../../core/index.mjs';
import { signEntry, KEY_ENV } from '../lib/sign.mjs';

const KEY = 'test-key-forest-format';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'gate-manifest-forest-test-'));
}
function cleanTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

let currentTestKey = null;
// Explicit-key wrapper — the library takes `key` as a required parameter now; withKey
// scopes the value the wrapper threads (see gate-manifest.test.mjs for the rationale).
const verify = (dir, opts = {}) => realVerify(dir, { key: currentTestKey, ...opts });
function withKey(key, fn) {
  const prevCurrent = currentTestKey;
  currentTestKey = key;
  const prev = process.env[KEY_ENV];
  if (key === null) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = key;
  try { return fn(); } finally {
    currentTestKey = prevCurrent;
    if (prev === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prev;
  }
}

/**
 * Build a signed (or unsigned, key=null) chain from partial entries. Each
 * partial may include `anchor` on its first element. Returns the array of
 * raw JSONL lines (strings), in order.
 *
 * @param {number} [signFrom]  0-based index of the first entry to sign;
 *   entries before it are left unsigned (a legacy prefix), entries from it
 *   onward are signed. Defaults to 0 (every entry signed) when `key` is set.
 */
function buildChainLines(partials, { key = null, signFrom = 0 } = {}) {
  const lines = [];
  let prevRawLine = null;
  let seq = 1;
  partials.forEach((partial, index) => {
    const entry = {
      seq,
      gate: 'evidence',
      ts: '2026-01-01T00:00:00.000Z',
      ...partial,
      files: partial.files ?? {},
      prev: prevRawLine === null ? null : sha256(prevRawLine),
    };
    if (key && index >= signFrom) {
      entry.sigVersion = 2;
      entry.sig = signEntry(key, entry);
    }
    const line = JSON.stringify(entry);
    lines.push(line);
    prevRawLine = line;
    seq += 1;
  });
  return lines;
}

function writeLines(filePath, lines) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, lines.length ? lines.join('\n') + '\n' : '');
}

function lineHashOf(lines, index) {
  return sha256(lines[index]);
}

describe('forest verify() — segment-free fast path (AC2)', () => {
  it('empty manifest, no manifest.d/, verifies exactly as the pre-forest single chain', () => {
    const dir = makeTmp();
    try {
      const result = verify(join(dir, '.adlc'));
      assert.deepEqual(result, { valid: true, message: 'empty manifest', count: 0, segments: 0, signed: false, break: null });
    } finally { cleanTmp(dir); }
  });

  it('a root-only manifest with entries verifies with segments:0', () => {
    const dir = makeTmp();
    try {
      const lines = buildChainLines([{ gate: 'a' }, { gate: 'b' }]);
      writeLines(join(dir, '.adlc', 'manifest.jsonl'), lines);
      const result = verify(join(dir, '.adlc'), { requireSignatures: false });
      assert.equal(result.valid, true);
      assert.equal(result.count, 2);
      assert.equal(result.segments, 0);
      assert.equal(result.message, 'manifest ok (2 entries)');
    } finally { cleanTmp(dir); }
  });

  it('an empty manifest.d/ directory (no segments yet) still takes the fast path', () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
      const result = verify(join(dir, '.adlc'));
      assert.deepEqual(result, { valid: true, message: 'empty manifest', count: 0, segments: 0, signed: false, break: null });
    } finally { cleanTmp(dir); }
  });

  it('a broken root chain on the fast path still labels break.segment as root (contract consistency)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      writeLines(join(adlc, 'manifest.jsonl'), ['{"seq":1,"gate":"x","ts":"2026-01-01T00:00:00.000Z","files":{},"prev":"deadbeef"}']);
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.equal(result.break.segment, 'root');
    } finally { cleanTmp(dir); }
  });
});

describe('forest verify() — a valid forest', () => {
  it('root + one segment anchored to root verifies, segments:1', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const rootLines = buildChainLines([{ gate: 'cross-model-review' }]);
      writeLines(join(adlc, 'manifest.jsonl'), rootLines);
      const anchor = { segment: 'root', seq: 1, lineHash: lineHashOf(rootLines, 0) };
      const segLines = buildChainLines([{ gate: 'evidence', anchor }, { gate: 'evidence' }]);
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), segLines);

      const result = verify(adlc, { requireSignatures: false });
      assert.equal(result.valid, true, result.message);
      assert.equal(result.segments, 1);
      assert.equal(result.count, 3); // 1 root + 2 segment
    } finally { cleanTmp(dir); }
  });

  it('root-less: two independent anchor:null segments both verify (§4.4/§9.3 concurrent-branch case)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const segA = buildChainLines([{ gate: 'evidence', anchor: null }]);
      const segB = buildChainLines([{ gate: 'evidence', anchor: null }]);
      writeLines(join(adlc, 'manifest.d', 'a-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), segA);
      writeLines(join(adlc, 'manifest.d', 'b-01BRZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), segB);

      const result = verify(adlc, { requireSignatures: false });
      assert.equal(result.valid, true, result.message);
      assert.equal(result.segments, 2);
    } finally { cleanTmp(dir); }
  });

  it('signed:true only when every chain in the forest verifies signed', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const rootLines = buildChainLines([{ gate: 'cross-model-review' }], { key: KEY });
      writeLines(join(adlc, 'manifest.jsonl'), rootLines);
      const anchor = { segment: 'root', seq: 1, lineHash: lineHashOf(rootLines, 0) };
      const segLines = buildChainLines([{ gate: 'evidence', anchor }], { key: KEY });
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), segLines);

      withKey(KEY, () => {
        const result = verify(adlc);
        assert.equal(result.valid, true, result.message);
        assert.equal(result.signed, true);
      });
    } finally { cleanTmp(dir); }
  });

  it('a legacy-unsigned root prefix is tolerated per-chain, independent of a fully-signed segment', () => {
    // The root has an honest history predating signing (entries 0-1 unsigned,
    // entry 2 onward signed) — this repo's own shape. The legacy-prefix
    // tolerance (#378) is evaluated per chain, so the segment's own signed
    // history is unaffected by the root's unsigned past, and vice versa.
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const rootLines = buildChainLines(
        [{ gate: 'old-unsigned-1' }, { gate: 'old-unsigned-2' }, { gate: 'first-signed' }],
        { key: KEY, signFrom: 2 }
      );
      writeLines(join(adlc, 'manifest.jsonl'), rootLines);
      const anchor = { segment: 'root', seq: 3, lineHash: lineHashOf(rootLines, 2) };
      const segLines = buildChainLines([{ gate: 'evidence', anchor }], { key: KEY });
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), segLines);

      withKey(KEY, () => {
        const result = verify(adlc, { requireSignatures: false });
        assert.equal(result.valid, true, result.message);
        assert.equal(result.count, 4);
      });
    } finally { cleanTmp(dir); }
  });

  it('an unsigned entry AFTER the root has gone signed-era still breaks the chain (no regression via appended plain entries)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const rootLines = buildChainLines(
        [{ gate: 'old-unsigned' }, { gate: 'first-signed' }, { gate: 'regressed-unsigned' }],
        { key: KEY, signFrom: 1 }
      );
      // Strip the sig back off the third (already-signed) entry to simulate
      // an attacker appending a plain entry after the ledger went signed-era.
      const regressed = JSON.parse(rootLines[2]);
      delete regressed.sig;
      delete regressed.sigVersion;
      rootLines[2] = JSON.stringify(regressed);
      writeLines(join(adlc, 'manifest.jsonl'), rootLines);

      withKey(KEY, () => {
        const result = verify(adlc, { requireSignatures: false });
        assert.equal(result.valid, false);
        assert.match(result.message, /unsigned entry/);
      });
    } finally { cleanTmp(dir); }
  });

  it('root-less repo with all-signed segments reports signed:true (empty root must not drag it down)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const segLines = buildChainLines([{ gate: 'evidence', anchor: null }], { key: KEY });
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), segLines);

      withKey(KEY, () => {
        const result = verify(adlc);
        assert.equal(result.valid, true, result.message);
        assert.equal(result.signed, true);
      });
    } finally { cleanTmp(dir); }
  });
});

describe('forest verify() — AC1 adversarial rejections', () => {
  it('a manifest.d/ that exists as a regular file (not a directory) fails closed, does not crash', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(adlc, { recursive: true });
      writeFileSync(join(adlc, 'manifest.d'), 'not a directory');
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /manifest\.d\/ is not a directory/);
    } finally { cleanTmp(dir); }
  });

  it('rejects malformed JSON in a segment', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), ['{not json', '{"seq":2}']);
      const result = verify(adlc, { requireSignatures: false });
      assert.equal(result.valid, false);
      assert.match(result.message, /malformed JSON/);
    } finally { cleanTmp(dir); }
  });

  it('rejects bad filename grammar', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      writeLines(join(adlc, 'manifest.d', 'Not-Valid-Grammar.jsonl'), buildChainLines([{ gate: 'x', anchor: null }]));
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /bad filename grammar/);
    } finally { cleanTmp(dir); }
  });

  it('rejects a lowercase ULID (grammar requires uppercase, no folding)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      writeLines(join(adlc, 'manifest.d', 'feat-01arz3ndektsv4rrffq69g5fav.jsonl'), buildChainLines([{ gate: 'x', anchor: null }]));
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /bad filename grammar/);
    } finally { cleanTmp(dir); }
  });

  it('rejects a symlinked segment file', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const real = join(dir, 'real.jsonl');
      writeFileSync(real, buildChainLines([{ gate: 'x', anchor: null }]).join('\n') + '\n');
      mkdirSync(join(adlc, 'manifest.d'), { recursive: true });
      symlinkSync(real, join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'));
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /symlink/);
    } finally { cleanTmp(dir); }
  });

  it('rejects a symlinked manifest.d/ directory itself', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const realDir = join(dir, 'real-manifest.d');
      mkdirSync(realDir, { recursive: true });
      mkdirSync(adlc, { recursive: true });
      symlinkSync(realDir, join(adlc, 'manifest.d'));
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /symlink/);
    } finally { cleanTmp(dir); }
  });

  it('rejects a DANGLING symlinked manifest.d/ (target does not exist) — existsSync would miss this', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(adlc, { recursive: true });
      // Never create the target: existsSync(segDir) follows the link and
      // returns false for a dangling one, which would skip the symlink
      // check entirely if discoverSegments checked existsSync first.
      symlinkSync(join(dir, 'never-created'), join(adlc, 'manifest.d'));
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /symlink/);
    } finally { cleanTmp(dir); }
  });

  it('rejects a nested directory under manifest.d/', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), { recursive: true });
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /nested directory/);
    } finally { cleanTmp(dir); }
  });

  it('a name that is a pure-case variant of a valid segment is rejected (as bad grammar, not silently accepted)', () => {
    // §4.2's grammar fixes casing per component (slug always lowercase,
    // ULID always uppercase, extension always lowercase), so a
    // grammar-VALID name's casing is fully determined by its content —
    // no two distinct grammar-valid names can ever be case-variants of
    // each other. A same-case-folded duplicate like 'FEAT-...' is
    // therefore always caught by the grammar check itself (dead code
    // is unreachable, not untested): this asserts the fail-closed
    // OUTCOME (rejected either way) rather than the specific one of two
    // valid reasons ('bad filename grammar' vs 'case-colliding') that
    // fires, since which one fires depends on the filesystem's own
    // case sensitivity and iteration order.
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const segDir = join(adlc, 'manifest.d');
      writeLines(join(segDir, 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor: null }]));
      writeLines(join(segDir, 'FEAT-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor: null }]));
      if (readdirSync(segDir).length < 2) {
        // Case-insensitive filesystem: the second write overwrote the
        // first, so there is only one (valid) file — nothing to reject.
        const result = verify(adlc);
        assert.equal(result.valid, true, result.message);
        return;
      }
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /bad filename grammar|case-colliding/);
    } finally { cleanTmp(dir); }
  });

  it('rejects a dangling anchor (points at a segment that does not exist)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const anchor = { segment: 'nonexistent-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl', seq: 1, lineHash: 'a'.repeat(64) };
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor }]));
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /dangling anchor/);
    } finally { cleanTmp(dir); }
  });

  it('rejects an anchor whose seq does not exist in the target chain', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const rootLines = buildChainLines([{ gate: 'x' }]);
      writeLines(join(adlc, 'manifest.jsonl'), rootLines);
      const anchor = { segment: 'root', seq: 99, lineHash: 'a'.repeat(64) };
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor }]));
      const result = verify(adlc, { requireSignatures: false });
      assert.equal(result.valid, false);
      assert.match(result.message, /dangling anchor/);
    } finally { cleanTmp(dir); }
  });

  it('rejects a lineHash mismatch (anchor to a real seq, wrong hash — repointed history)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const rootLines = buildChainLines([{ gate: 'x' }]);
      writeLines(join(adlc, 'manifest.jsonl'), rootLines);
      const anchor = { segment: 'root', seq: 1, lineHash: 'f'.repeat(64) };
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor }]));
      const result = verify(adlc, { requireSignatures: false });
      assert.equal(result.valid, false);
      assert.match(result.message, /lineHash mismatch/);
    } finally { cleanTmp(dir); }
  });

  it('rejects an anchor cycle (two segments anchored to each other)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      // Build both chains first (without anchors) to know their line hashes,
      // then rewrite each first line to anchor at the OTHER — a cycle.
      const aName = 'a-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl';
      const bName = 'b-01BRZ3NDEKTSV4RRFFQ69G5FAV.jsonl';
      const aLine0 = JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: { segment: bName, seq: 1, lineHash: 'placeholder' } });
      const bLine0 = JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: { segment: aName, seq: 1, lineHash: sha256(aLine0) } });
      const aLine0Final = JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: { segment: bName, seq: 1, lineHash: sha256(bLine0) } });
      writeLines(join(adlc, 'manifest.d', aName), [aLine0Final]);
      writeLines(join(adlc, 'manifest.d', bName), [bLine0]);
      const result = verify(adlc, { requireSignatures: false });
      assert.equal(result.valid, false);
      // A cycle means at least one side's anchor cannot resolve consistently
      // with the other (whichever line hash is recomputed last wins the
      // "real" content) — either a dangling/mismatch or an explicit cycle
      // report is an acceptable fail-closed outcome; the forest must never
      // verify:true over a cyclic anchor graph.
      assert.match(result.message, /lineHash mismatch|anchor cycle|dangling anchor/);
    } finally { cleanTmp(dir); }
  });

  it('rejects anchor:null once a root exists', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      writeLines(join(adlc, 'manifest.jsonl'), buildChainLines([{ gate: 'x' }]));
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor: null }]));
      const result = verify(adlc, { requireSignatures: false });
      assert.equal(result.valid, false);
      assert.match(result.message, /anchor: null is not permitted once a root exists/);
    } finally { cleanTmp(dir); }
  });

  it('rejects a segment first entry missing the required anchor field', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x' }]));
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /missing required anchor field/);
    } finally { cleanTmp(dir); }
  });

  it('rejects a genuinely empty segment file (no first entry, so no anchor at all)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), []);
      const result = verify(adlc);
      assert.equal(result.valid, false, result.message);
      assert.match(result.message, /empty segment file/);
    } finally { cleanTmp(dir); }
  });

  it('rejects an anchor field on a non-first segment entry', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const lines = buildChainLines([{ gate: 'x', anchor: null }, { gate: 'y' }]);
      // Splice a bogus anchor onto the second (already-chained) line.
      const second = JSON.parse(lines[1]);
      second.anchor = null;
      lines[1] = JSON.stringify(second);
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), lines);
      const result = verify(adlc);
      assert.equal(result.valid, false);
      assert.match(result.message, /only a segment's first entry may carry an anchor/);
    } finally { cleanTmp(dir); }
  });

  it('rejects an anchor field on a root entry', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const rootLines = buildChainLines([{ gate: 'x', anchor: null }]);
      writeLines(join(adlc, 'manifest.jsonl'), rootLines);
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor: { segment: 'root', seq: 1, lineHash: sha256(rootLines[0]) } }]));
      const result = verify(adlc, { requireSignatures: false });
      assert.equal(result.valid, false);
      assert.match(result.message, /root entry must not carry an anchor/);
    } finally { cleanTmp(dir); }
  });

  it('a payload attempting to supply anchor is a writer-side concern (documented, not re-tested here)', () => {
    // §4.4: appendManifestEntry MUST reject payloads that supply `anchor` —
    // covered by the segment-writer slice's own test suite once that lands.
    assert.ok(true);
  });
});

describe('readManifestForest — ordering', () => {
  it('a segment anchored to another segment sorts AFTER its parent, even when its name string-sorts first', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      // Named so a naive string comparison of anchor.segment would put the
      // child ('a-...', anchored to 'z-...') before its parent ('z-...',
      // anchored to root) — depth-based ordering must still put the parent
      // first regardless of filename.
      const parentName = 'z-parent-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl';
      const childName = 'a-child-01BRZ3NDEKTSV4RRFFQ69G5FAV.jsonl';
      const parentLines = buildChainLines([{ gate: 'parent-entry', anchor: null }]);
      writeLines(join(adlc, 'manifest.d', parentName), parentLines);
      const childAnchor = { segment: parentName, seq: 1, lineHash: lineHashOf(parentLines, 0) };
      writeLines(join(adlc, 'manifest.d', childName), buildChainLines([{ gate: 'child-entry', anchor: childAnchor }]));

      const { entries } = readManifestForest(adlc);
      const gates = entries.map((e) => e.gate);
      assert.deepEqual(gates, ['parent-entry', 'child-entry']);
    } finally { cleanTmp(dir); }
  });

  it('two root-less segments sharing a ULID (different slugs) still sort deterministically', () => {
    // A same-ULID collision across different slugs isn't forbidden by §4.2
    // (unlike same-name-different-case, which discoverSegments rejects), so
    // the sort comparator must stay total even here rather than returning 0
    // for two genuinely different filenames.
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      const sharedUlid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      writeLines(join(adlc, 'manifest.d', `b-${sharedUlid}.jsonl`), buildChainLines([{ gate: 'b-entry', anchor: null }]));
      writeLines(join(adlc, 'manifest.d', `a-${sharedUlid}.jsonl`), buildChainLines([{ gate: 'a-entry', anchor: null }]));

      const { entries } = readManifestForest(adlc);
      const gates = entries.map((e) => e.gate);
      assert.deepEqual(gates, ['a-entry', 'b-entry']);
    } finally { cleanTmp(dir); }
  });

  it('a valid-JSON non-object line (null, a number, a bare array) is skipped, not fabricated into a phantom entry', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      writeLines(join(adlc, 'manifest.jsonl'), ['null', '42', '[1,2,3]']);
      const { entries, skipped } = readManifestForest(adlc);
      assert.deepEqual(entries, []);
      assert.equal(skipped.length, 3);
      assert.ok(skipped.every((s) => s.error === 'entry must be an object'));
    } finally { cleanTmp(dir); }
  });
});

describe('discoverSegments — grammar edge cases', () => {
  it('accepts a slug containing every digit 0-9, not just 0-1 (full character-class range)', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      writeLines(join(adlc, 'manifest.d', 'v0123456789-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor: null }]));
      const { valid, invalid } = discoverSegments(adlc);
      assert.deepEqual(invalid, []);
      assert.deepEqual(valid, ['v0123456789-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl']);
    } finally { cleanTmp(dir); }
  });

  it('.lineage is a structural file, not a segment — skipped, never reported as invalid', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(join(adlc, 'manifest.d'), { recursive: true });
      writeFileSync(join(adlc, 'manifest.d', '.lineage'), JSON.stringify({ segment: 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl', branch: 'main' }));
      const { valid, invalid } = discoverSegments(adlc);
      assert.deepEqual(valid, []);
      assert.deepEqual(invalid, []);
    } finally { cleanTmp(dir); }
  });

  // adversarial-review finding: withLedgerLock (T-MANIFEST-FOREST slice 3, the
  // writer) names its advisory lock '<segment>.jsonl.lock', which does NOT
  // match SEGMENT_NAME_RE (it doesn't end in exactly '.jsonl'). Left
  // unhandled, discoverSegments would report a live lock file as a
  // bad-filename-grammar segment, and verify() treats ANY non-empty `invalid`
  // as failing the WHOLE forest — turning "another writer is mid-append,
  // please wait" into "the manifest forest is invalid" for every concurrent
  // reader or writer, breaking spec §7's "concurrent writers serialize"
  // guarantee. The skip is CONTENT-aware (a follow-up adversarial-review
  // finding on the first fix): only a name ending in .lock whose content
  // genuinely matches withLedgerLock's own owner-record shape is skipped —
  // a real segment renamed to dodge grammar validation does not match that
  // shape and is still caught, see the negative case below.
  const genuineLockOwner = () => JSON.stringify({ version: 1, token: 'owner-token-uuid', pid: 12345, hostname: 'ci-runner', startedAt: '2026-01-01T00:00:00.000Z' });

  it('a live *.lock file with a genuine owner-record body is a structural artifact, not a segment — skipped', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(join(adlc, 'manifest.d'), { recursive: true });
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor: null }]));
      writeFileSync(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl.lock'), genuineLockOwner());
      const { valid, invalid } = discoverSegments(adlc);
      assert.deepEqual(invalid, []);
      assert.deepEqual(valid, ['feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl']);
      assert.equal(verify(adlc).valid, true, 'a concurrent writer holding a segment lock must not fail verify() for everyone else');
    } finally { cleanTmp(dir); }
  });

  // adversarial-review finding: withLedgerLock creates the lock file
  // (openSync 'wx') and writes its owner JSON (writeFileSync) as two
  // SEPARATE syscalls — a genuine lock is briefly 0 bytes between them. An
  // empty file must be treated the same as a genuine lock (skipped), not
  // reported invalid, or a concurrent reader whose scan lands in that
  // split-second window fails the whole forest for a perfectly healthy
  // in-flight write.
  it('a *.lock file that is transiently EMPTY (mid-creation) is treated as a genuine lock, not invalid', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(join(adlc, 'manifest.d'), { recursive: true });
      writeLines(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), buildChainLines([{ gate: 'x', anchor: null }]));
      writeFileSync(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl.lock'), '');
      const { valid, invalid } = discoverSegments(adlc);
      assert.deepEqual(invalid, []);
      assert.deepEqual(valid, ['feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl']);
      assert.equal(verify(adlc).valid, true);
    } finally { cleanTmp(dir); }
  });

  it('a real segment renamed to end in .lock is NOT silently hidden — its content does not match a genuine lock', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(join(adlc, 'manifest.d'), { recursive: true });
      // A real, chained segment's bytes — an attacker's rename target, not a lock.
      writeLines(join(adlc, 'manifest.d', 'evil-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl.lock'), buildChainLines([{ gate: 'cross-model-review', data: { verdict: 'approve' }, anchor: null }]));
      const { valid, invalid } = discoverSegments(adlc);
      assert.deepEqual(valid, [], 'a disguised real segment must never be treated as valid content either');
      assert.equal(invalid.length, 1);
      assert.equal(invalid[0].name, 'evil-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl.lock');
      assert.match(invalid[0].reason, /not a genuine advisory lock/);
    } finally { cleanTmp(dir); }
  });

  it('an oversized *.lock file is refused, not treated as a genuine lock', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(join(adlc, 'manifest.d'), { recursive: true });
      writeFileSync(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl.lock'), JSON.stringify({ version: 1, token: 'x'.repeat(2000), pid: 1, hostname: 'h', startedAt: '2026-01-01T00:00:00.000Z' }));
      const { valid, invalid } = discoverSegments(adlc);
      assert.deepEqual(valid, []);
      assert.equal(invalid.length, 1);
      assert.match(invalid[0].reason, /not a genuine advisory lock/);
    } finally { cleanTmp(dir); }
  });

  it('the lock size-cap boundary is exact: 512 bytes is refused, 511 is accepted', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(join(adlc, 'manifest.d'), { recursive: true });
      const lockFile = join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl.lock');
      const build = (padLen) => JSON.stringify({ version: 1, token: 'x'.repeat(padLen), pid: 1, hostname: 'h', startedAt: '2026-01-01T00:00:00.000Z' });
      let pad = 0;
      let json = build(pad);
      while (json.length < 512) { pad += 1; json = build(pad); }
      assert.equal(json.length, 512, 'test construction sanity check');
      writeFileSync(lockFile, json);
      assert.deepEqual(discoverSegments(adlc).invalid.map((i) => i.name), ['feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl.lock'], 'exactly the cap must be refused');

      const jsonUnderCap = build(pad - 1);
      assert.equal(jsonUnderCap.length, 511);
      writeFileSync(lockFile, jsonUnderCap);
      assert.deepEqual(discoverSegments(adlc).invalid, [], 'one byte under the cap must be accepted as a genuine lock');
    } finally { cleanTmp(dir); }
  });

  it('a *.lock file whose content is not even valid JSON is refused, not treated as a genuine lock', () => {
    const dir = makeTmp();
    try {
      const adlc = join(dir, '.adlc');
      mkdirSync(join(adlc, 'manifest.d'), { recursive: true });
      writeFileSync(join(adlc, 'manifest.d', 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl.lock'), 'not json at all');
      const { valid, invalid } = discoverSegments(adlc);
      assert.deepEqual(valid, []);
      assert.equal(invalid.length, 1);
      assert.match(invalid[0].reason, /not a genuine advisory lock/);
    } finally { cleanTmp(dir); }
  });
});

describe('renderEntry — segment label (§6)', () => {
  it('labels a non-root entry with its segment id', () => {
    const lines = renderEntry({ seq: 1, gate: 'evidence', ts: '2026-01-01T00:00:00.000Z', segment: 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl', files: {}, prev: null });
    assert.ok(lines.includes('  segment: feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'));
  });

  it('does not label a root entry (AC2: byte-identical to the pre-forest renderer)', () => {
    const lines = renderEntry({ seq: 1, gate: 'evidence', ts: '2026-01-01T00:00:00.000Z', segment: 'root', files: {}, prev: null });
    assert.ok(!lines.some((l) => l.startsWith('  segment:')));
  });
});

describe('forest primitives — unit coverage', () => {
  it('discoverSegments reports invalid entries without throwing', () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
      writeFileSync(join(dir, '.adlc', 'manifest.d', 'bad name!!.jsonl'), '');
      const { valid, invalid } = discoverSegments(join(dir, '.adlc'));
      assert.deepEqual(valid, []);
      assert.equal(invalid.length, 1);
      assert.equal(invalid[0].reason, 'bad filename grammar');
    } finally { cleanTmp(dir); }
  });

  it('resolveAnchor accepts null', () => {
    assert.deepEqual(resolveAnchor(null, new Map()), { ok: true });
  });

  it('resolveAnchor rejects a malformed anchor shape', () => {
    assert.equal(resolveAnchor({ segment: 'root' }, new Map()).ok, false);
    assert.equal(resolveAnchor('root', new Map()).ok, false);
  });

  it('detectAnchorCycle passes a simple two-node chain (a -> root)', () => {
    const anchorBySegment = new Map([['a', { segment: 'root', seq: 1, lineHash: 'x' }]]);
    assert.deepEqual(detectAnchorCycle(anchorBySegment), { ok: true });
  });

  it('detectAnchorCycle catches a direct two-segment cycle', () => {
    const anchorBySegment = new Map([
      ['a', { segment: 'b', seq: 1, lineHash: 'x' }],
      ['b', { segment: 'a', seq: 1, lineHash: 'y' }],
    ]);
    const result = detectAnchorCycle(anchorBySegment);
    assert.equal(result.ok, false);
  });
});
