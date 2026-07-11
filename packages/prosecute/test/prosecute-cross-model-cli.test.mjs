// Concern: bin/adlc-prosecute.mjs trust-root-tier gate + record-cross-model
// subcommand (T39 AC3/AC5, end-to-end at the process boundary). Builds a scratch
// git repo so `git diff --name-only <base>...HEAD` yields a real trust-root diff,
// and proves the recorded revision resolves to the SAME string the gate checks
// (record-cross-model reuses resolveProsecutionRevision) — no --revision passed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256 } from '@adlc/core';
import { resolveProsecutionRevision } from '../lib/run.mjs';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

function runBin(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// A scratch repo whose feature branch touches `featurePath`, with a .adlc/
// evidence bundle (passes + transcript + review packet) in place. Default touches
// an enforcement package (trust-root tier); pass an ordinary path for the negative.
function scratchRepo(featurePath = 'packages/prosecute/lib/feature.mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-xm-cli-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  // Feature work on its own branch so `git diff main...HEAD` yields a real diff.
  g('checkout', '-q', '-b', 'feat');
  const abs = join(dir, ...featurePath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n');
  g('add', '-A'); g('commit', '-qm', `touch ${featurePath}`);

  // .adlc evidence bundle. Files under .adlc/ satisfy isEvidencePath and are
  // revision-ignored, so the resolved revision is stable across invocations.
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  writeFileSync(join(adlc, 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] }],
  }));
  const transcriptPath = join(adlc, 'review.txt');
  writeFileSync(transcriptPath, [
    'ticket: T1',
    'reviewed revision: (resolved at run time)',
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  const promptPath = join(adlc, 'prompt.txt');
  const inputsPath = join(adlc, 'inputs.txt');
  writeFileSync(promptPath, 'review prompt\n');
  writeFileSync(inputsPath, 'reviewed input packet\n');
  const passesPath = join(adlc, 'passes.json');
  return { dir, adlc, transcriptPath, promptPath, inputsPath, passesPath };
}

// The transcript must reference the resolved revision, and the review packet's
// clean_worktree must equal it. Resolve it via a dry gate run (--json), then
// rewrite the evidence to bind that revision, keeping the files revision-ignored.
function writePasses({ passesPath, transcriptPath, promptPath, inputsPath, revision }) {
  writeFileSync(transcriptPath, [
    'ticket: T1',
    `reviewed revision: ${revision}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  writeFileSync(passesPath, JSON.stringify({
    provenance: { reviewer: 'r', session: 's', command: 'c', transcript: transcriptPath },
    review_packet: {
      prompt: promptPath, prompt_hash: sha256(readFileSync(promptPath)),
      inputs: inputsPath, inputs_hash: sha256(readFileSync(inputsPath)),
      clean_worktree: revision,
    },
    no_findings_attestation: { reason: 'none', method: 'audit', evidence: 'review.txt' },
    passes: [
      { lens: 'security', findings: [], dry_evidence: 'no security findings' },
      { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
    ],
  }));
}

// Resolve the reviewed revision exactly as the bin does (cwd = repo root, same
// --input/--dir), so the evidence can be bound to it before the gate runs.
function resolveRev(repo) {
  const input = JSON.parse(readFileSync(repo.passesPath, 'utf8'));
  return resolveProsecutionRevision({ cwd: repo.dir, dir: '.adlc', input, inputPath: '.adlc/passes.json' });
}

describe('adlc-prosecute trust-root-tier CLI gate', () => {
  it('exits 2 without an attestation, then 0 once a distinct-provider approve is recorded (revision resolved by both)', () => {
    const repo = scratchRepo();
    try {
      // 1) Resolve the revision the gate will use with the evidence in place.
      writePasses({ ...repo, revision: 'placeholder' });
      const revision = resolveRev(repo);
      assert.ok(revision, 'gate resolves a revision');

      // 2) Rebind the evidence to the resolved revision and run the gate for real.
      writePasses({ ...repo, revision });
      const fail = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--json'], repo.dir);
      assert.equal(fail.status, 2);
      const failParsed = JSON.parse(fail.stdout);
      assert.match(failParsed.message, /cross-model adversarial approve from a distinct provider/);

      // 3) Record a distinct-provider approve via the subcommand — it resolves the
      //    SAME revision (same --input, no --revision), so the gate then clears.
      const rec = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--input', '.adlc/passes.json', '--base', 'main', '--dir', '.adlc', '--json'], repo.dir);
      assert.equal(rec.status, 0);
      assert.equal(JSON.parse(rec.stdout).data.revision, revision, 'recorded revision matches the gate revision');

      const pass = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--json'], repo.dir);
      assert.equal(pass.status, 0);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('record-cross-model fails closed (exit 1) when provider === author-provider', () => {
    const repo = scratchRepo();
    try {
      writePasses({ ...repo, revision: 'r' });
      const rec = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'anthropic', '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', '.adlc'], repo.dir);
      assert.equal(rec.status, 1);
      assert.match(rec.stderr, /distinct from the author/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('an ordinary (non-trust-root) diff is not gated by cross-model', () => {
    // Feature branch touches only a docs file — not any trust-root surface.
    const repo = scratchRepo('apps/docs/x.mdx');
    try {
      writePasses({ ...repo, revision: 'placeholder' });
      const revision = resolveRev(repo);
      writePasses({ ...repo, revision });
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', '.adlc', '--json'], repo.dir);
      assert.equal(res.status, 0, 'ordinary diff passes P5 with no cross-model attestation');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('FAILS CLOSED (exit 1) when the base ref is unresolvable — never a silent ungated pass', () => {
    // Even with a P5 that would otherwise converge, an unresolvable base ref means
    // the tier cannot be decided, so the gate must REFUSE (op-error) rather than
    // run ungated. This pins the fail-closed direction the ADLC review requires.
    const repo = scratchRepo('apps/docs/x.mdx'); // an ordinary diff — would pass P5 if it ran
    try {
      writePasses({ ...repo, revision: 'placeholder' });
      const revision = resolveRev(repo);
      writePasses({ ...repo, revision });
      const res = runBin(['--input', '.adlc/passes.json', '--ticket', 'T1', '--base', 'no-such-ref', '--dir', '.adlc', '--json'], repo.dir);
      assert.equal(res.status, 1, 'unresolvable base ref must be exit 1, not a silent ungated exit 0');
      assert.match(res.stderr, /cannot determine trust-root tier: base ref 'no-such-ref' unresolvable/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});
