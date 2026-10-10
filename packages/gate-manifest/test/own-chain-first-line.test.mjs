// Concern: readOwnManifestChain resolves each segment's FIRST entry from the raw
// first LINE — issue #652.
//
// `readManifestForest` is lenient and skips an unparseable line. Resolving a
// segment's first entry from the first SURVIVING parsed entry therefore returned
// the segment's SECOND entry when line 1 was corrupt; that entry carries no
// `anchor`, the walk broke with root never reached, and root's evidence vanished
// with `identityError: null`. A consumer replaying open findings then saw none.
// These tests pin the refusal — identityError set, entries empty, the message in
// `skipped` — for the own segment, for an ancestor, and for an oversized line.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOwnManifestChain } from '../lib/own-chain.mjs';
import { writeLineageToken, MAX_FIRST_LINE_BYTES } from '../lib/lineage.mjs';

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const OUR_BRANCH = 'feat/own-chain-first-line';
const OTHER_BRANCH = 'feat/somebody-elses-work';
const ULID_FIRST = '0'.repeat(26);
const ULID_LAST = 'Z'.repeat(26);
const OURS = `ours-${ULID_LAST}.jsonl`;
const PARENT = `parent-${ULID_FIRST}.jsonl`;

function repo(branch = OUR_BRANCH) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-own-chain-first-line-'));
  fixtureDirs.add(root);
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

function writeRoot(dir, entries) {
  writeFileSync(join(dir, 'manifest.jsonl'), entries.map((e, i) => JSON.stringify({ seq: i + 1, ...e })).join('\n') + '\n');
}

function activateSegments(dir) {
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
}

/** A segment anchored to `parent` (root by default) at `parentSeq`. */
function writeSegment(dir, name, { branch, parent = 'root', parentSeq = 1, entries }) {
  activateSegments(dir);
  const lines = entries.map((e, i) => JSON.stringify(
    i === 0
      ? { seq: 1, anchor: { segment: parent, seq: parentSeq, lineHash: 'a'.repeat(64) }, branch, ...e }
      : { seq: i + 1, ...e }
  ));
  writeFileSync(join(dir, 'manifest.d', name), lines.join('\n') + '\n');
}

/** Cut the segment's first line in half so it no longer parses; later lines are intact. */
function truncateFirstLine(dir, name) {
  const path = join(dir, 'manifest.d', name);
  const lines = readFileSync(path, 'utf8').split('\n');
  lines[0] = lines[0].slice(0, Math.floor(lines[0].length / 2));
  writeFileSync(path, lines.join('\n'));
}

const gates = (result) => result.entries.map((e) => e.gate);

const expectRefusal = (result, segment) => {
  assert.equal(typeof result.identityError, 'string', 'identityError must be set');
  assert.match(result.identityError, /first line/);
  assert.ok(result.identityError.includes(segment), `identityError should name ${segment}: ${result.identityError}`);
  assert.deepEqual(result.entries, []);
  assert.ok(result.skipped.some((s) => s.error === result.identityError), 'skipped must carry the same message');
};

describe('readOwnManifestChain: the own segment\'s first line (issue #652 repro)', () => {
  it('reads the whole chain while line 1 is intact, then refuses once line 1 is truncated', () => {
    const { root, dir } = repo();
    writeRoot(dir, [{ gate: 'p5-finding' }, { gate: 'p5-complete' }]);
    writeSegment(dir, OURS, { branch: OUR_BRANCH, parentSeq: 2, entries: [{ gate: 'seg-a' }, { gate: 'seg-b' }] });
    writeLineageToken(dir, { segment: OURS, ulid: ULID_LAST, branch: OUR_BRANCH });

    const before = readOwnManifestChain(dir, { cwd: root });
    assert.equal(before.identityError, null);
    assert.deepEqual(gates(before), ['p5-finding', 'p5-complete', 'seg-a', 'seg-b']);

    truncateFirstLine(dir, OURS);

    const after = readOwnManifestChain(dir, { cwd: root });
    expectRefusal(after, OURS);
    assert.ok(!gates(after).includes('seg-b'), 'the second entry must not stand in for the first');
  });

  it('refuses when the first line is oversized (no newline within MAX_FIRST_LINE_BYTES)', () => {
    const { root, dir } = repo();
    writeRoot(dir, [{ gate: 'r1' }]);
    activateSegments(dir);
    const huge = { seq: 1, anchor: { segment: 'root', seq: 1, lineHash: 'a'.repeat(64) }, branch: OUR_BRANCH, gate: 'ours1', pad: 'x'.repeat(MAX_FIRST_LINE_BYTES) };
    writeFileSync(join(dir, 'manifest.d', OURS), JSON.stringify(huge)); // deliberately no trailing newline
    writeLineageToken(dir, { segment: OURS, ulid: ULID_LAST, branch: OUR_BRANCH });

    expectRefusal(readOwnManifestChain(dir, { cwd: root }), OURS);
  });
});

describe('readOwnManifestChain: an ancestor\'s first line', () => {
  function threeHop() {
    const { root, dir } = repo();
    writeRoot(dir, [{ gate: 'r1' }]);
    writeSegment(dir, PARENT, { branch: OTHER_BRANCH, parentSeq: 1, entries: [{ gate: 'p1' }, { gate: 'p2' }] });
    writeSegment(dir, OURS, { branch: OUR_BRANCH, parent: PARENT, parentSeq: 2, entries: [{ gate: 'ours1' }] });
    writeLineageToken(dir, { segment: OURS, ulid: ULID_LAST, branch: OUR_BRANCH });
    return { root, dir };
  }

  it('resolves a healthy own → parent → root chain exactly as before', () => {
    const { root, dir } = threeHop();
    const result = readOwnManifestChain(dir, { cwd: root });
    assert.equal(result.identityError, null);
    assert.deepEqual(gates(result), ['r1', 'p1', 'p2', 'ours1']);
    assert.equal(result.ownSegment, OURS);
  });

  it('refuses, naming the parent, when the parent\'s first line is malformed', () => {
    const { root, dir } = threeHop();
    truncateFirstLine(dir, PARENT);
    expectRefusal(readOwnManifestChain(dir, { cwd: root }), PARENT);
  });

  it('refuses when a first line parses but is not an entry object', () => {
    const { root, dir } = threeHop();
    const path = join(dir, 'manifest.d', PARENT);
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[0] = '42';
    writeFileSync(path, lines.join('\n'));
    expectRefusal(readOwnManifestChain(dir, { cwd: root }), PARENT);
  });
});
