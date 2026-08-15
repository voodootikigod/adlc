// Concern: the finding-lifecycle replay must not read forest ARRAY POSITION as
// chronology (T-01M01HTKD290FQQB4NDCV60Q24).
//
// seedOpenFindingsFromManifest replays a ticket+revision's findings
// sequentially — `set` on verified, `delete` on killed — so its answer depends
// entirely on the order it walks entries in. `readManifestForest` orders
// segments by anchor topology for DISPLAY, which its own header says is
// deliberately not causal across independent segments: a foreign branch's ULID
// decides whether its entries land before or after ours.
//
// The dangerous direction is a foreign kill sorting AFTER our verification —
// it deletes a finding that is genuinely still open on our chain, and the run
// then completes past it. Every test here builds a second segment belonging to
// another branch, which the frozen root made ordinary.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProsecution } from '../lib/run.mjs';
import { appendManifestEntry } from '@adlc/gate-manifest';
import { sha256 } from '@adlc/core';

const OUR_BRANCH = 'feat/own-chain-prosecute-fixture';
const OTHER_BRANCH = 'feat/somebody-elses-work';
const REVISION = 'fixture-revision';

// The prosecution's own appends verify the WHOLE forest before writing, so
// these fixtures are built by the real writer rather than hand-rolled: a
// hand-written line has no `prev`/hash chain and the run refuses before it
// reaches the behaviour under test. Which chain an entry lands in is decided
// the way production decides it — by the branch that is checked out.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-prosecute-own-chain-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', OUR_BRANCH);
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 'Fixture ticket', scope: ['src/**'], rails: ['test/**'], edges: [] }],
  }));
  return { root, dir, g };
}
const clean = (root) => rmSync(root, { recursive: true, force: true });

const append = (dir, root, entry) => appendManifestEntry(entry, dir, { key: null, cwd: root });

// Segments only exist once the repo has cut over; before that every append
// lands in root. Flipping this mid-fixture is how a test puts some entries in
// root and the rest in a segment.
function activateSegments(dir) {
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
}

// A segment belonging to somebody else, minted the way theirs really would be:
// on their branch. It sorts after ours whenever it is created later (segment
// names carry a time-ordered ULID) — and that is exactly the accident these
// consumers must stop depending on.
function onBranch(dir, root, g, branch, entries) {
  const previous = g('rev-parse', '--abbrev-ref', 'HEAD').trim();
  g('checkout', '-q', '-b', branch);
  try {
    for (const entry of entries) append(dir, root, entry);
  } finally {
    g('checkout', '-q', previous);
    // `.lineage` is a local pointer at whatever was last minted; leaving
    // theirs behind would be a fixture artefact no real checkout has, since
    // peekOpenSegment ignores a token naming another branch anyway.
    try { unlinkSync(join(dir, 'manifest.d', '.lineage')); } catch { /* no token to clear */ }
  }
}

// The finding content the identity hash is derived from — id, file, lines,
// category, claim, evidence. Two entries resolve each other only when all six
// match, so the fixture states them once.
const FINDING = {
  id: 'F1',
  file: 'src/app.mjs',
  line_start: 1,
  line_end: 1,
  category: 'correctness',
  claim: 'wrong result',
  evidence: 'return false',
};

function findingEntry(type) {
  return { type, ticket: 'T1', revision: REVISION, pass: 1, lens: 'security', finding: FINDING };
}

function dryInput(dir) {
  const transcriptPath = join(dir, 'review.txt');
  writeFileSync(transcriptPath, [
    'ticket: T1',
    `reviewed revision: ${REVISION}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  const prompt = join(dir, 'review-prompt.txt');
  const inputs = join(dir, 'review-inputs.txt');
  writeFileSync(prompt, `review prompt for ${REVISION}\n`);
  writeFileSync(inputs, `reviewed input packet for ${REVISION}\n`);
  return {
    provenance: {
      reviewer: 'fixture-reviewer',
      session: 'fixture-session',
      command: 'fixture review command',
      transcript: transcriptPath,
    },
    review_packet: {
      prompt,
      prompt_hash: sha256(readFileSync(prompt)),
      inputs,
      inputs_hash: sha256(readFileSync(inputs)),
      clean_worktree: REVISION,
    },
    no_findings_attestation: {
      reason: 'fixture reviewer found no candidates',
      method: 'review transcript audit',
      evidence: 'review.txt',
    },
    passes: [
      { lens: 'security', findings: [], dry_evidence: 'no security findings' },
      { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
    ],
  };
}

const prosecute = (root, dir) => runProsecution(dryInput(dir), { key: null, dir, ticket: 'T1', revision: REVISION, cwd: root });
const segmentNames = (dir) => readdirSync(join(dir, 'manifest.d')).filter((n) => n.endsWith('.jsonl'));

describe('finding replay: a foreign segment does not dispose of this chain\'s findings', () => {
  it('keeps a finding open when only a foreign segment carries its kill', () => {
    const { root, dir, g } = repo();
    try {
      append(dir, root, findingEntry('p5-finding-verified'));
      activateSegments(dir);
      // Minted after ours and so sorted after it. A whole-forest replay walks
      // it AFTER our verification and deletes a finding nobody on this chain
      // ever refuted, letting three dry passes complete over the top of it.
      onBranch(dir, root, g, OTHER_BRANCH, [findingEntry('p5-finding-killed')]);

      const result = prosecute(root, dir);
      assert.equal(result.exitCode, 2);
      assert.equal(result.openFindings.length, 1);
      assert.equal(result.openFindings[0].id, 'F1');
    } finally { clean(root); }
  });

  it('stays resolved when our own chain killed it and a foreign segment re-verifies it', () => {
    const { root, dir, g } = repo();
    try {
      append(dir, root, findingEntry('p5-finding-verified'));
      append(dir, root, findingEntry('p5-finding-killed'));
      activateSegments(dir);
      onBranch(dir, root, g, OTHER_BRANCH, [findingEntry('p5-finding-verified')]);

      const result = prosecute(root, dir);
      assert.deepEqual(result.openFindings, []);
      assert.equal(result.exitCode, 0);
    } finally { clean(root); }
  });

  it('still honours a kill recorded in our OWN segment — scoping narrows the read, it does not ignore segments', () => {
    const { root, dir } = repo();
    try {
      append(dir, root, findingEntry('p5-finding-verified'));
      activateSegments(dir);
      append(dir, root, findingEntry('p5-finding-killed')); // mints OUR segment

      assert.equal(segmentNames(dir).length, 1);
      const result = prosecute(root, dir);
      assert.deepEqual(result.openFindings, []);
      assert.equal(result.exitCode, 0);
    } finally { clean(root); }
  });

  it('refuses before its first append when this checkout\'s own segment cannot be identified', () => {
    const { root, dir } = repo();
    try {
      append(dir, root, findingEntry('p5-finding-verified'));
      activateSegments(dir);
      append(dir, root, { gate: 'noop' });               // mints our segment
      unlinkSync(join(dir, 'manifest.d', '.lineage'));   // the lost-token case §7 anticipates
      // A non-conforming object in manifest.d/ could be a disguised segment —
      // ours, for all recovery can tell — so identity becomes undecidable and
      // the replay must refuse rather than run on whatever it could still read.
      writeFileSync(join(dir, 'manifest.d', 'not-a-segment.jsonl'), '{"seq":1}\n');
      const before = segmentNames(dir).sort();
      const rootLinesBefore = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');

      const result = prosecute(root, dir);
      assert.equal(result.status, 'op-error');
      assert.equal(result.exitCode, 1);
      assert.equal(result.errors.some((e) => /refusing to prosecute: cannot establish this checkout's own causal chain/.test(e)), true);
      // A rejected run leaves no trace: no fresh segment minted, nothing appended.
      assert.deepEqual(segmentNames(dir).sort(), before);
      assert.equal(readFileSync(join(dir, 'manifest.jsonl'), 'utf8'), rootLinesBefore);
    } finally { clean(root); }
  });
});
