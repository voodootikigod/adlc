// adopt.test.mjs — the operator remediation for an ambiguous lineage
// (T-01KYZDJTF7WE40JH25QTNAWB1Y, spec §7.1(b)).
//
// When two committed segments declare the same branch and no local token
// disambiguates them, every token-less write fails closed. That refusal is
// correct; adopt is the supported way out — an operator names the lineage to
// continue, and adopt writes the local token.
//
// THE LOAD-BEARING CONSTRAINT: the token is a TRUST anchor, not a pointer.
// readOwnChains treats a token match as proof this checkout minted the
// segment and skips signature verification on that basis. So adopt must
// apply exactly the gate resolveOpenSegment applies to a recovered
// candidate — chain intact, branch-bearing FIRST entry carrying a verified
// v2 signature — or adopt becomes a supported bypass of that gate from the
// other side.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planAdopt, adopt } from '../lib/adopt.mjs';
import { markerPath, lineagePath, resolveOpenSegment, peekOpenSegment, deriveSlug, generateSegmentUlid } from '../lib/lineage.mjs';
import { appendManifestEntry } from '../lib/record.mjs';
import { segmentPath, discoverSegments, readRawLines } from '../lib/forest.mjs';
import { signEntry } from '../lib/sign.mjs';
import { sha256 } from '@adlc/core';

const BIN = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;
const KEY = 'adopt-test-key';
const NEGATED = '.adlc/*\n!.adlc/manifest.jsonl\n!.adlc/manifest.d/\n!.adlc/manifest.d/**\n.adlc/manifest.d/.lineage\n.adlc/manifest.d/*.lock\n';

function gitRepo(branch = 'feat/adopt') {
  const root = mkdtempSync(join(tmpdir(), 'gate-manifest-adopt-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', branch);
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'), NEGATED);
  g('add', '.gitignore');
  g('commit', '-q', '-m', 'init');
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  return { root, dir, g };
}

function activate(dir, auth = 'keyed') {
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(markerPath(dir), JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth }));
}

// Two legitimately-minted, signed segments for one branch — the exact state
// two isolated clones produce when each writes before seeing the other, then
// both land. Each mint happens while the OTHER segment is invisible, because
// a writer that can see an existing same-branch segment recovers it instead
// of minting (that is gap-1's fix working); isolation is what makes the
// duplicate legitimate rather than a bug.
function twoCandidates(root, dir) {
  const stash = mkdtempSync(join(tmpdir(), 'gate-manifest-adopt-stash-'));
  appendManifestEntry({ gate: 'evidence', data: { note: 'first-clone' } }, dir, { cwd: root, key: KEY });
  const a = discoverSegments(dir).valid[0];
  renameSync(segmentPath(dir, a), join(stash, a)); // the second clone cannot see A
  rmSync(lineagePath(dir), { force: true });
  appendManifestEntry({ gate: 'evidence', data: { note: 'second-clone' } }, dir, { cwd: root, key: KEY });
  const b = discoverSegments(dir).valid.find((n) => n !== a);
  renameSync(join(stash, a), segmentPath(dir, a)); // both land
  rmSync(lineagePath(dir), { force: true }); // the third, fresh checkout: no token
  rmSync(stash, { recursive: true, force: true });
  return { a, b };
}

function clean(root) { rmSync(root, { recursive: true, force: true }); }

function runBin(root, ...args) {
  const env = { ...process.env, ADLC_MANIFEST_KEY: KEY };
  return spawnSync(process.execPath, [BIN, 'adopt', ...args], { cwd: root, encoding: 'utf8', env });
}

describe('planAdopt — list mode (AC1)', () => {
  it('enumerates every same-branch candidate WITHOUT calling recovery, which throws on exactly this ambiguity', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const { a, b } = twoCandidates(root, dir);
      // Precondition: the state adopt exists to resolve really does block writes.
      assert.throws(() => resolveOpenSegment(dir, { cwd: root, key: KEY }), /ambiguous/);

      const plan = planAdopt(dir, { cwd: root, key: KEY });
      assert.equal(plan.decision, 'list');
      assert.deepEqual(plan.candidates.map((c) => c.name).sort(), [a, b].sort());
      for (const c of plan.candidates) {
        assert.equal(c.entries, 1, 'each candidate reports its entry count');
        assert.equal(c.authenticated, true, 'both were genuinely signed by this key');
        assert.ok(typeof c.firstTs === 'string' && c.firstTs.length > 0);
      }
    } finally { clean(root); }
  });

  it('lists a single candidate too — adopt is also the way to re-point a lost token', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root, key: KEY });
      rmSync(lineagePath(dir), { force: true });
      const plan = planAdopt(dir, { cwd: root, key: KEY });
      assert.equal(plan.decision, 'list');
      assert.equal(plan.candidates.length, 1);
    } finally { clean(root); }
  });

  it('reports no candidates in a segmented repo with no segments at all', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const plan = planAdopt(dir, { cwd: root, key: KEY });
      assert.equal(plan.decision, 'list');
      assert.deepEqual(plan.candidates, []);
    } finally { clean(root); }
  });
});

describe('adopt — happy path (AC2)', () => {
  it('writes a token that makes the NEXT write extend the chosen segment, leaving the other byte-identical', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const { a, b } = twoCandidates(root, dir);
      const bBytes = readFileSync(segmentPath(dir, b));

      const out = adopt(dir, { cwd: root, key: KEY, segment: a, write: true });
      assert.equal(out.decision, 'adopted');
      assert.equal(out.written, true);
      assert.equal(out.segment, a);

      // The token resolves, and the ambiguity refusal is gone.
      const peeked = peekOpenSegment(dir, { cwd: root });
      assert.equal(peeked?.name, a, 'the token must actually resolve to the adopted segment');
      const resolved = resolveOpenSegment(dir, { cwd: root, key: KEY });
      assert.equal(resolved.name, a);
      assert.equal(resolved.isNew, false);

      // A real append extends the adopted lineage and nothing else.
      appendManifestEntry({ gate: 'evidence', data: { note: 'after-adopt' } }, dir, { cwd: root, key: KEY });
      assert.equal(readRawLines(segmentPath(dir, a)).length, 2, 'the adopted segment gained the entry');
      assert.deepEqual(readFileSync(segmentPath(dir, b)), bBytes, 'the OTHER candidate must stay byte-identical — adopt never edits committed evidence');
      assert.deepEqual(discoverSegments(dir).valid.sort(), [a, b].sort(), 'no third segment was minted');
    } finally { clean(root); }
  });

  it('is idempotent: adopting the already-adopted segment succeeds and leaves the token unchanged', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const { a } = twoCandidates(root, dir);
      adopt(dir, { cwd: root, key: KEY, segment: a, write: true });
      const bytes = readFileSync(lineagePath(dir));
      const again = adopt(dir, { cwd: root, key: KEY, segment: a, write: true });
      assert.equal(again.decision, 'adopted');
      assert.deepEqual(readFileSync(lineagePath(dir)), bytes);
    } finally { clean(root); }
  });
});

describe('adopt — refusals (AC3)', () => {
  it('refuses a segment that declares a DIFFERENT branch', () => {
    const { root, dir, g } = gitRepo('feat/mine');
    try {
      activate(dir);
      appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root, key: KEY });
      const theirs = discoverSegments(dir).valid[0];
      g('checkout', '-q', '-b', 'feat/other');
      rmSync(lineagePath(dir), { force: true });
      const out = adopt(dir, { cwd: root, key: KEY, segment: theirs, write: true });
      assert.equal(out.decision, 'refuse-wrong-branch');
      assert.equal(existsSync(lineagePath(dir)), false, 'no token may be written');
    } finally { clean(root); }
  });

  it('refuses a segment whose first entry is not v2-authenticated — adopt must not launder into the trusted peeked path', () => {
    const { root, dir } = gitRepo('feat/v1-claim');
    try {
      activate(dir);
      // A v1 signature does not cover `branch`, so this branch claim is unauthenticated.
      const entry = { seq: 1, gate: 'evidence', ts: '2026-01-01T00:00:00.000Z', data: {}, files: {}, prev: null };
      entry.sig = signEntry(KEY, entry);
      entry.anchor = null;
      entry.branch = 'feat/v1-claim';
      const name = `${deriveSlug('feat/v1-claim')}-${generateSegmentUlid()}.jsonl`;
      writeFileSync(segmentPath(dir, name), `${JSON.stringify(entry)}\n`);

      const out = adopt(dir, { cwd: root, key: KEY, segment: name, write: true });
      assert.equal(out.decision, 'refuse-unauthenticated');
      assert.equal(existsSync(lineagePath(dir)), false);
    } finally { clean(root); }
  });

  it('refuses a chain-broken segment', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root, key: KEY });
      const name = discoverSegments(dir).valid[0];
      rmSync(lineagePath(dir), { force: true });
      // Append a forged, unsigned continuation — chain-valid prev, no signature.
      const firstRaw = readFileSync(segmentPath(dir, name), 'utf8').trim();
      const forged = { seq: 2, gate: 'evidence', ts: '2026-01-02T00:00:00.000Z', data: {}, files: {}, prev: sha256(firstRaw) };
      writeFileSync(segmentPath(dir, name), `${firstRaw}\n${JSON.stringify(forged)}\n`);

      const out = adopt(dir, { cwd: root, key: KEY, segment: name, write: true });
      assert.equal(out.decision, 'refuse-unauthenticated');
      assert.equal(existsSync(lineagePath(dir)), false);
    } finally { clean(root); }
  });

  it('refuses a KEYED-mode forest when no key is available — mirroring the resolvers persisted-auth enforcement', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir, 'keyed');
      const { a } = twoCandidates(root, dir);
      const out = adopt(dir, { cwd: root, key: null, segment: a, write: true });
      assert.equal(out.decision, 'refuse-keyed-forest');
      assert.equal(existsSync(lineagePath(dir)), false);
    } finally { clean(root); }
  });

  it('refuses an unknown segment name, and a name that is not grammar-valid', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      twoCandidates(root, dir);
      for (const bogus of ['no-such-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl', '../escape.jsonl', 'not-a-segment']) {
        const out = adopt(dir, { cwd: root, key: KEY, segment: bogus, write: true });
        assert.equal(out.decision, 'refuse-unknown-segment', `bogus=${bogus}`);
        assert.equal(existsSync(lineagePath(dir)), false);
      }
    } finally { clean(root); }
  });

  it('refuses a non-segmented repo and a detached HEAD', () => {
    const { root, dir } = gitRepo();
    try {
      assert.equal(planAdopt(dir, { cwd: root, key: KEY }).decision, 'refuse-not-segmented');
      activate(dir);
      const { a } = twoCandidates(root, dir);
      execFileSync('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      const out = adopt(dir, { cwd: root, key: KEY, segment: a, write: true });
      assert.equal(out.decision, 'refuse-detached-head', 'a detached checkout has no branch to bind the token to');
      assert.equal(existsSync(lineagePath(dir)), false);
    } finally { clean(root); }
  });
});

describe('adopt — dry-run and JSON contract (AC4)', () => {
  it('dry-run resolves and reports the plan but writes no token', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const { a } = twoCandidates(root, dir);
      const out = adopt(dir, { cwd: root, key: KEY, segment: a });
      assert.equal(out.decision, 'adopted');
      assert.equal(out.written, false);
      assert.equal(existsSync(lineagePath(dir)), false, 'dry-run must not write the token');
    } finally { clean(root); }
  });

  it('CLI: list, adopt, and refusal each emit exactly one JSON document with the right exit code', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const { a } = twoCandidates(root, dir);

      const list = runBin(root, '--json');
      assert.equal(list.status, 0, list.stderr);
      assert.equal(JSON.parse(list.stdout).decision, 'list');

      const bad = runBin(root, 'no-such-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl', '--json');
      assert.equal(bad.status, 2);
      assert.equal(JSON.parse(bad.stdout).decision, 'refuse-unknown-segment');

      const ok = runBin(root, a, '--write', '--json');
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(JSON.parse(ok.stdout).decision, 'adopted');
      assert.equal(peekOpenSegment(dir, { cwd: root })?.name, a);
    } finally { clean(root); }
  });

  it('CLI: human-readable list names both candidates and tells the operator how to choose', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const { a, b } = twoCandidates(root, dir);
      const r = runBin(root);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(a) && r.stdout.includes(b), 'both candidates listed');
      assert.match(r.stdout, /--write/, 'the output must say how to apply a choice');
    } finally { clean(root); }
  });
});
