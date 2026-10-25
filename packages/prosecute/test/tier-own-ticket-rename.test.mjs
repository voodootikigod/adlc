// Concern: when a custom in-repo --dir ticket table is renamed or moved on the
// branch, readBaseDirTickets resolves its base-side source path so base rails
// are not misclassified as newly added own rails.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sha256 } from '@adlc/core';
import { resolveProsecutionRevision } from '../lib/run.mjs';

const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
process.env.ADLC_MANIFEST_KEY = 'test-tier-own-ticket-rename-signing-key';
const PINNED_GIT_DATE = '2026-01-01T00:00:00Z';

function runBin(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const T = (over = {}) => ({ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [], ...over });

function writeFile(dir, rel, content) {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function renamedDirRepo({ commitRename = true, baseRails = ['docs/secret.md'], headRails = baseRails, editedFile = 'docs/secret.md' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-tier-own-rename-'));
  fixtureDirs.add(dir);
  const g = (...a) => execFileSync('git', a, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_DATE: PINNED_GIT_DATE, GIT_COMMITTER_DATE: PINNED_GIT_DATE },
  });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFile(dir, 'README.md', 'baseline\n');
  writeFile(dir, '.adlc/tickets.json', JSON.stringify({ tickets: [] }));
  writeFile(dir, 'custom/tickets.json', JSON.stringify({ tickets: [T({ rails: baseRails })] }));
  writeFile(dir, 'docs/secret.md', 'a\n');
  writeFile(dir, 'src/new/x.mjs', 'a\n');
  writeFile(dir, 'a-unrelated-old.mjs', 'export const k = 1;\n');
  writeFile(dir, '.adlc/review.txt', 'placeholder\n');
  writeFile(dir, '.adlc/prompt.txt', 'review prompt\n');
  writeFile(dir, '.adlc/inputs.txt', 'reviewed input packet\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  g('checkout', '-q', '-b', 'feat');
  mkdirSync(join(dir, 'moved'), { recursive: true });
  g('mv', 'custom/tickets.json', 'moved/tickets.json');
  g('mv', 'a-unrelated-old.mjs', 'b-unrelated-new.mjs');
  if (JSON.stringify(headRails) !== JSON.stringify(baseRails)) {
    writeFile(dir, 'moved/tickets.json', JSON.stringify({ tickets: [T({ rails: headRails })] }));
    g('add', 'moved/tickets.json');
  }
  writeFile(dir, editedFile, 'b\n');
  g('add', editedFile);
  if (commitRename) g('commit', '-qm', 'move custom table and edit');
  return dir;
}

function writePasses(dir, ticket, revision, ticketDir = 'moved') {
  const adlc = join(dir, '.adlc');
  const outDir = join(dir, ticketDir);
  writeFileSync(join(adlc, 'review.txt'), [
    `ticket: ${ticket}`,
    `reviewed revision: ${revision}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  const prompt = join(adlc, 'prompt.txt');
  const inputs = join(adlc, 'inputs.txt');
  writeFileSync(join(outDir, 'passes.json'), JSON.stringify({
    provenance: { reviewer: 'r', session: 's', command: 'c', transcript: join(adlc, 'review.txt') },
    review_packet: {
      prompt, prompt_hash: sha256(readFileSync(prompt)),
      inputs, inputs_hash: sha256(readFileSync(inputs)),
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

function record(dir, ticket, ticketDir = 'moved') {
  const inputPath = `${ticketDir}/passes.json`;
  writePasses(dir, ticket, 'placeholder', ticketDir);
  const input = JSON.parse(readFileSync(join(dir, ticketDir, 'passes.json'), 'utf8'));
  const revision = resolveProsecutionRevision({ cwd: dir, dir: ticketDir, input, inputPath });
  assert.ok(revision, 'the recorder resolves a revision');
  writePasses(dir, ticket, revision, ticketDir);
  return runBin(['--input', inputPath, '--ticket', ticket, '--base', 'main', '--dir', ticketDir, '--author-provider', 'anthropic', '--json'], dir);
}

describe('renamed custom --dir ticket table preserves base rails (#1267)', () => {
  it('tier-check on a renamed custom --dir table tiers on the base rail and does not skip it as new', () => {
    const dir = renamedDirRepo({ commitRename: true });
    const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'moved', '--ticket', 'T1', '--json'], dir);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.reasons, ['touches rails deny-path of ticket T1: docs/secret.md']);
    assert.deepEqual(out.skippedOwnRails, []);
    assert.ok(!r.stderr.includes('skipped own new rail'), r.stderr);
    assert.match(r.stderr, /touches rails deny-path of ticket T1: docs\/secret\.md/);
  });

  it('tier-check on a staged-only rename of a custom --dir table also preserves the base rail', () => {
    const dir = renamedDirRepo({ commitRename: false });
    const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'moved', '--ticket', 'T1', '--json'], dir);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.reasons, ['touches rails deny-path of ticket T1: docs/secret.md']);
    assert.deepEqual(out.skippedOwnRails, []);
    assert.ok(!r.stderr.includes('skipped own new rail'), r.stderr);
  });

  it('the recorder on a renamed custom --dir table exits 2 requiring cross-model review and does not skip the base rail', () => {
    const dir = renamedDirRepo({ commitRename: true });
    const r = record(dir, 'T1', 'moved');
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /touches rails deny-path of ticket T1: docs\/secret\.md/);
    assert.ok(!r.stderr.includes('skipped own new rail'), r.stderr);
    const manifestPath = join(dir, 'moved', 'manifest.jsonl');
    assert.ok(existsSync(manifestPath));
    assert.match(readFileSync(manifestPath, 'utf8'), /"type":"p5-cross-model-missing"/);
  });

  it('a genuinely new rail added to the renamed table is still skipped while the base rail still tiers', () => {
    const dir = renamedDirRepo({
      commitRename: true,
      baseRails: ['docs/secret.md'],
      headRails: ['docs/secret.md', 'src/new/**'],
      editedFile: 'src/new/x.mjs',
    });
    const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'moved', '--ticket', 'T1', '--json'], dir);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout).skippedOwnRails, ['src/new/**']);
  });
});
