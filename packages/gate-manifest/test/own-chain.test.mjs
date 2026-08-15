// Concern: readOwnManifestChain — the causally-ordered slice of the forest.
//
// readManifestForest orders segments by anchor topology so display is stable,
// and says in its own header that this is NOT a causal or temporal order across
// independent segments. Consumers that read array position as chronology
// (`.at(-1)`, `indexOf`, `slice`, a sequential set/delete replay) therefore
// cannot read the forest; they read this instead. These tests pin the two
// properties that makes true: unrelated segments are never returned, and what
// IS returned is in an order this checkout can defend.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOwnManifestChain } from '../lib/own-chain.mjs';
import { readManifestForest } from '../lib/forest.mjs';
import { writeLineageToken } from '../lib/lineage.mjs';

const OUR_BRANCH = 'feat/own-chain-fixture';
const OTHER_BRANCH = 'feat/somebody-elses-work';
// Crockford base32, uppercase — SEGMENT_NAME_RE's alphabet. The two extremes so
// a fixture can put a foreign segment either side of ours in the forest's sort.
const ULID_FIRST = '0'.repeat(26);
const ULID_LAST = 'Z'.repeat(26);

function repo(branch = OUR_BRANCH) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-own-chain-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', branch);
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}
const clean = (root) => rmSync(root, { recursive: true, force: true });

function writeRoot(dir, entries) {
  writeFileSync(join(dir, 'manifest.jsonl'), entries.map((e, i) => JSON.stringify({ seq: i + 1, ...e })).join('\n') + '\n');
}

function activateSegments(dir) {
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
}

// Hand-built, like cross-model.test.mjs's writeCrossModelSegment: this is a
// LENIENT read, so a fixture only needs the shape the reader actually looks at
// — a grammar-valid filename, and a first entry carrying `anchor` and `branch`.
function writeSegment(dir, name, { branch, anchorSeq = 1, entries }) {
  activateSegments(dir);
  const lines = entries.map((e, i) => JSON.stringify(
    i === 0
      ? { seq: 1, anchor: { segment: 'root', seq: anchorSeq, lineHash: 'a'.repeat(64) }, branch, ...e }
      : { seq: i + 1, ...e }
  ));
  writeFileSync(join(dir, 'manifest.d', name), lines.join('\n') + '\n');
  return name;
}

const gates = (result) => result.entries.map((e) => e.gate);
const OURS = `ours-${ULID_FIRST}.jsonl`;
const THEIRS_LATER = `theirs-${ULID_LAST}.jsonl`;
const THEIRS_EARLIER = `theirs-${ULID_FIRST}.jsonl`;

describe('readOwnManifestChain: unrelated segments are not this chain', () => {
  it('returns root then our own segment, dropping a foreign segment that sorts AFTER ours', () => {
    const { root, dir } = repo();
    try {
      writeRoot(dir, [{ gate: 'r1' }]);
      writeSegment(dir, OURS, { branch: OUR_BRANCH, entries: [{ gate: 'ours1' }, { gate: 'ours2' }] });
      writeSegment(dir, THEIRS_LATER, { branch: OTHER_BRANCH, entries: [{ gate: 'theirs1' }] });

      // The forest genuinely orders the foreign segment last, which is what
      // makes `.at(-1)` on it answer with somebody else's evidence.
      assert.deepEqual(readManifestForest(dir).entries.map((e) => e.gate), ['r1', 'ours1', 'ours2', 'theirs1']);
      const result = readOwnManifestChain(dir, { cwd: root });
      assert.deepEqual(gates(result), ['r1', 'ours1', 'ours2']);
      assert.equal(result.ownSegment, OURS);
      assert.equal(result.identityError, null);
    } finally { clean(root); }
  });

  it('drops a foreign segment that sorts BEFORE ours too — position is not the criterion, ownership is', () => {
    const { root, dir } = repo();
    try {
      writeRoot(dir, [{ gate: 'r1' }]);
      writeSegment(dir, THEIRS_EARLIER, { branch: OTHER_BRANCH, entries: [{ gate: 'theirs1' }] });
      writeSegment(dir, `ours-${ULID_LAST}.jsonl`, { branch: OUR_BRANCH, entries: [{ gate: 'ours1' }] });

      assert.deepEqual(readManifestForest(dir).entries.map((e) => e.gate), ['r1', 'theirs1', 'ours1']);
      assert.deepEqual(gates(readOwnManifestChain(dir, { cwd: root })), ['r1', 'ours1']);
    } finally { clean(root); }
  });

  it('is identical to the whole forest when the only segment is ours', () => {
    const { root, dir } = repo();
    try {
      writeRoot(dir, [{ gate: 'r1' }, { gate: 'r2' }]);
      writeSegment(dir, OURS, { branch: OUR_BRANCH, anchorSeq: 2, entries: [{ gate: 'ours1' }] });

      assert.deepEqual(gates(readOwnManifestChain(dir, { cwd: root })), readManifestForest(dir).entries.map((e) => e.gate));
    } finally { clean(root); }
  });

  it('is identical to the whole forest in a repo that never segmented', () => {
    const { root, dir } = repo();
    try {
      writeRoot(dir, [{ gate: 'r1' }, { gate: 'r2' }]);
      const result = readOwnManifestChain(dir, { cwd: root });
      assert.deepEqual(gates(result), ['r1', 'r2']);
      assert.equal(result.ownSegment, null);
      assert.equal(result.identityError, null);
    } finally { clean(root); }
  });
});

describe('readOwnManifestChain: root is kept only as far as it is provably prior', () => {
  it('drops root entries appended after our segment forked — they are concurrent, not before', () => {
    const { root, dir } = repo();
    try {
      writeRoot(dir, [{ gate: 'r1' }, { gate: 'r2' }, { gate: 'r3' }]);
      writeSegment(dir, OURS, { branch: OUR_BRANCH, anchorSeq: 2, entries: [{ gate: 'ours1' }] });

      assert.deepEqual(gates(readOwnManifestChain(dir, { cwd: root })), ['r1', 'r2', 'ours1']);
    } finally { clean(root); }
  });

  it('keeps the whole of root when our segment anchors at its tip — the frozen-root case', () => {
    const { root, dir } = repo();
    try {
      writeRoot(dir, [{ gate: 'r1' }, { gate: 'r2' }, { gate: 'r3' }]);
      writeSegment(dir, OURS, { branch: OUR_BRANCH, anchorSeq: 3, entries: [{ gate: 'ours1' }] });

      assert.deepEqual(gates(readOwnManifestChain(dir, { cwd: root })), ['r1', 'r2', 'r3', 'ours1']);
    } finally { clean(root); }
  });
});

describe('readOwnManifestChain: an unidentifiable checkout refuses, it does not read as empty', () => {
  it('reports identityError when two committed segments both declare our branch', () => {
    const { root, dir } = repo();
    try {
      writeRoot(dir, [{ gate: 'r1' }]);
      writeSegment(dir, OURS, { branch: OUR_BRANCH, entries: [{ gate: 'ours1' }] });
      writeSegment(dir, `ours-${ULID_LAST}.jsonl`, { branch: OUR_BRANCH, entries: [{ gate: 'ours2' }] });

      const result = readOwnManifestChain(dir, { cwd: root });
      assert.equal(result.ownSegment, null);
      assert.match(result.identityError, /cannot identify this checkout's own segment/);
      assert.match(result.identityError, /ambiguous/);
      // Reported on BOTH channels: assertPhase reads `skipped`, prosecute reads
      // `identityError`, and neither may see "no evidence" here.
      assert.equal(result.skipped.some((s) => s.error === result.identityError), true);
      // Root still comes back — it is unambiguously ours — but no segment does.
      assert.deepEqual(gates(result), ['r1']);
    } finally { clean(root); }
  });

  it('resolves cleanly when the local .lineage token disambiguates the two', () => {
    const { root, dir } = repo();
    try {
      writeRoot(dir, [{ gate: 'r1' }]);
      writeSegment(dir, OURS, { branch: OUR_BRANCH, entries: [{ gate: 'ours1' }] });
      writeSegment(dir, `ours-${ULID_LAST}.jsonl`, { branch: OUR_BRANCH, entries: [{ gate: 'ours2' }] });
      writeLineageToken(dir, { segment: OURS, ulid: ULID_FIRST, branch: OUR_BRANCH });

      const result = readOwnManifestChain(dir, { cwd: root });
      assert.equal(result.identityError, null);
      assert.deepEqual(gates(result), ['r1', 'ours1']);
    } finally { clean(root); }
  });

  it('reports identityError when manifest.d/ holds a non-conforming object that could be a disguised segment', () => {
    const { root, dir } = repo();
    try {
      writeRoot(dir, [{ gate: 'r1' }]);
      writeSegment(dir, OURS, { branch: OUR_BRANCH, entries: [{ gate: 'ours1' }] });
      writeFileSync(join(dir, 'manifest.d', 'not-a-segment.jsonl'), '{"seq":1}\n');

      const result = readOwnManifestChain(dir, { cwd: root });
      assert.match(result.identityError, /cannot identify this checkout's own segment/);
      assert.deepEqual(gates(result), ['r1']);
    } finally { clean(root); }
  });
});
