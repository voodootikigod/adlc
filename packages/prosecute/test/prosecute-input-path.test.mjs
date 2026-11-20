// Concern: --input and provenance.transcript are excluded from the change-set identity, so an
// in-tree path outside the evidence directories would let real source change without moving the
// reviewed revision. They are refused (exit 1); .adlc/ regular files and external files pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { revisionIgnorePaths, resolveProsecutionRevision } from '../lib/run.mjs';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
process.env.ADLC_MANIFEST_KEY = 'prosecute-input-path-test-key';
const KEY = process.env.ADLC_MANIFEST_KEY;

function runBin(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ADLC_MANIFEST_KEY: KEY },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function initRepo(dir) {
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] }],
  }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 0;\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  g('checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'change');
}

const RECORD = ['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--base', 'main', '--dir', '.adlc'];

test('revisionIgnorePaths and adlc-prosecute reject in-tree --input and provenance.transcript paths outside .adlc/ or .omo/evidence/ with exit 1 while allowing .adlc/ regular files and external temp files', () => {
  // revisionIgnorePaths: only evidence-ish or external paths may be ignored.
  const cwd = resolve('/tmp/adlc-ignore-fixture');
  const ignored = revisionIgnorePaths(cwd, '.adlc', {
    provenance: { transcript: 'src/transcript.txt' },
    review_packet: { prompt: '.omo/evidence/prompt.txt', inputs: '/elsewhere/inputs.txt' },
  }, 'src/passes.json');
  assert.ok(!ignored.includes(join(cwd, 'src', 'passes.json')), 'in-tree source --input is not ignored');
  assert.ok(!ignored.includes(join(cwd, 'src', 'transcript.txt')), 'in-tree source transcript is not ignored');
  assert.ok(ignored.includes(join(cwd, '.omo', 'evidence', 'prompt.txt')));
  assert.ok(ignored.includes('/elsewhere/inputs.txt'));
  assert.ok(revisionIgnorePaths(cwd, '.adlc', undefined, '.adlc/passes.json').includes(join(cwd, '.adlc', 'passes.json')));
  assert.ok(revisionIgnorePaths(cwd, 'ledger', undefined, 'ledger/passes.json').includes(join(cwd, 'ledger', 'passes.json')), 'the --dir ledger directory counts as evidence');

  const dir = mkdtempSync(join(tmpdir(), 'adlc-input-path-'));
  const external = mkdtempSync(join(tmpdir(), 'adlc-input-path-ext-'));
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'src', 'passes.json'), '{}');
    const inTree = runBin([...RECORD, '--input', 'src/passes.json'], dir);
    assert.equal(inTree.status, 1);
    assert.match(inTree.stderr, /in-repository evidence path must live under \.adlc\/ or \.omo\/evidence\//);
    const prosecute = runBin(['--input', 'src/passes.json', '--ticket', 'T1', '--base', 'main'], dir);
    assert.equal(prosecute.status, 1);
    assert.match(prosecute.stderr, /in-repository evidence path must live under/);
    rmSync(join(dir, 'src', 'passes.json'));

    // provenance.transcript naming in-tree source is refused too.
    writeFileSync(join(dir, '.adlc', 'bad-transcript.json'), JSON.stringify({ provenance: { transcript: 'src/app.mjs' } }));
    const badTranscript = runBin([...RECORD, '--input', '.adlc/bad-transcript.json'], dir);
    assert.equal(badTranscript.status, 1);
    assert.match(badTranscript.stderr, /in-repository evidence path must live under/);
    rmSync(join(dir, '.adlc', 'bad-transcript.json'));

    // A symlink (including a dangling symlink) is refused even when it sits under .adlc/.
    writeFileSync(join(external, 'real.json'), '{}');
    symlinkSync(join(external, 'real.json'), join(dir, '.adlc', 'link.json'));
    const symlinked = runBin([...RECORD, '--input', '.adlc/link.json'], dir);
    assert.equal(symlinked.status, 1);
    assert.match(symlinked.stderr, /evidence path must not be a symlink/);
    rmSync(join(dir, '.adlc', 'link.json'));

    symlinkSync(join(external, 'nonexistent.json'), join(dir, '.adlc', 'dangling.json'));
    const dangling = runBin([...RECORD, '--input', '.adlc/dangling.json'], dir);
    assert.equal(dangling.status, 1);
    assert.match(dangling.stderr, /evidence path must not be a symlink/);
    rmSync(join(dir, '.adlc', 'dangling.json'));

    const missingInput = runBin(['--input', '.adlc/missing.json', '--ticket', 'T1', '--base', 'main'], dir);
    assert.equal(missingInput.status, 1);
    assert.match(missingInput.stderr, /^error: could not read input:/m);

    // A regular file under .adlc/ and an external temp file are both accepted.
    writeFileSync(join(dir, '.adlc', 'passes.json'), '{}');
    const underAdlc = runBin([...RECORD, '--input', '.adlc/passes.json'], dir);
    assert.equal(underAdlc.status, 0, underAdlc.stderr);
    rmSync(join(dir, '.adlc', 'passes.json'));
    const outside = runBin([...RECORD, '--input', join(external, 'real.json')], dir);
    assert.equal(outside.status, 0, outside.stderr);

    // Custom --dir ledger: passes.json, transcript, and review_packet artifacts under custom/ succeed end-to-end.
    const sha = (buf) => createHash('sha256').update(buf).digest('hex');
    mkdirSync(join(dir, 'custom'), { recursive: true });
    writeFileSync(join(dir, 'custom', 'tickets.json'), JSON.stringify({
      tickets: [{ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] }],
    }));
    writeFileSync(join(dir, 'custom', 'prompt.txt'), 'review prompt\n');
    writeFileSync(join(dir, 'custom', 'inputs.txt'), 'reviewed input packet\n');
    writeFileSync(join(dir, 'custom', 'review.txt'), 'placeholder\n');
    writeFileSync(join(dir, 'custom', 'passes.json'), '{}');
    const customRev = resolveProsecutionRevision({ cwd: dir, dir: 'custom', base: 'main', inputPath: 'custom/passes.json' });
    writeFileSync(join(dir, 'custom', 'review.txt'), [
      'ticket: T1',
      `reviewed revision: ${customRev}`,
      'review transcript fixture with enough detail to be accepted as evidence',
      'review transcript fixture with enough detail to be accepted as evidence',
    ].join('\n'));
    writeFileSync(join(dir, 'custom', 'passes.json'), JSON.stringify({
      provenance: { reviewer: 'r', session: 's', command: 'c', transcript: 'custom/review.txt' },
      review_packet: {
        prompt: 'custom/prompt.txt', prompt_hash: sha(Buffer.from('review prompt\n')),
        inputs: 'custom/inputs.txt', inputs_hash: sha(Buffer.from('reviewed input packet\n')),
        clean_worktree: customRev,
      },
      no_findings_attestation: { reason: 'none', method: 'audit', evidence: 'custom/review.txt' },
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }));
    const customRun = runBin(['--input', 'custom/passes.json', '--ticket', 'T1', '--base', 'main', '--dir', 'custom', '--json'], dir);
    assert.equal(customRun.status, 0, customRun.stderr || customRun.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
