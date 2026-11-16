import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { runProsecution } from '../lib/run.mjs';
import { appendManifestEntry } from '@adlc/gate-manifest';
import { readOwnManifestChain } from '@adlc/gate-manifest/lib/own-chain.mjs';
import { resolveOpenSegment, peekOpenSegment, recoverOpenSegment } from '@adlc/tickets/lib/manifest-primitives.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

test('runProsecution, readOwnManifestChain, and manifest-primitives resolve relative dir against explicit cwd rather than process.cwd()', (t) => {
  const repo = tmp(t, 'prosecute-cwd-repo-');
  const outsideCwd = tmp(t, 'prosecute-outside-cwd-');

  git(repo, 'init', '-b', 'main');
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(
    join(repo, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'Test ticket', rails: [] }] })
  );
  writeFileSync(join(repo, 'app.js'), 'export const v = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'base');
  git(repo, 'checkout', '-b', 'feat/cwd-check');
  writeFileSync(join(repo, 'app.js'), 'export const v = 2;\n');
  git(repo, 'add', 'app.js');
  git(repo, 'commit', '-m', 'change');

  const origCwd = process.cwd();
  process.chdir(outsideCwd);
  t.after(() => process.chdir(origCwd));

  // Activate segmented manifest in repo/.adlc while process.cwd() is outsideCwd
  mkdirSync(join(repo, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(
    join(repo, '.adlc', 'manifest.d', '.store.json'),
    JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyless' })
  );
  appendManifestEntry({ ts: new Date().toISOString(), gate: 'coldstart', ticket: 'T1', data: { gaps: [] } }, join(repo, '.adlc'), { cwd: repo, key: null });

  const seg = resolveOpenSegment('.adlc', { cwd: repo });
  assert.equal(seg.isNew, false);
  assert.equal(peekOpenSegment('.adlc', { cwd: repo })?.name, seg.name);
  assert.equal(recoverOpenSegment('.adlc', { cwd: repo })?.name, seg.name);

  const chain = readOwnManifestChain('.adlc', { cwd: repo });
  assert.equal(chain.identityError, null);

  // Prosecution with default dir = '.adlc' and explicit cwd = repo reads/writes repo/.adlc
  const rev = `git-change:${git(repo, 'rev-parse', 'main').trim()}:${'a'.repeat(64)}`;
  const transcriptPath = join(repo, '.adlc', 'review-transcript.txt');
  writeFileSync(
    transcriptPath,
    `ticket: T1\nreviewed revision: ${rev}\nAll lenses examined cleanly with zero findings.\n`
  );
  const promptPath = join(repo, '.adlc', 'prompt.txt');
  const inputsPath = join(repo, '.adlc', 'inputs.txt');
  writeFileSync(promptPath, 'prosecute prompt content');
  writeFileSync(inputsPath, 'prosecute inputs content');
  const sha = (p) => execFileSync('node', ['-e', `const crypto=require('crypto'),fs=require('fs');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(p)})).digest('hex'))`], { encoding: 'utf8' });

  const res = runProsecution(
    {
      provenance: {
        reviewer: 'test-model',
        session: 'sess-1',
        command: 'adlc prosecute',
        transcript: '.adlc/review-transcript.txt',
      },
      review_packet: {
        prompt: '.adlc/prompt.txt',
        prompt_hash: sha(promptPath),
        inputs: '.adlc/inputs.txt',
        inputs_hash: sha(inputsPath),
        clean_worktree: rev,
      },
      no_findings_attestation: {
        reason: 'All files inspected cleanly',
        method: 'line-by-line review',
        evidence: 'app.js:1',
      },
      passes: [
        { lens: 'correctness', findings: [], dry_evidence: 'app.js:1 inspected' },
        { lens: 'security', findings: [], dry_evidence: 'app.js:1 inspected' },
        { lens: 'contract', findings: [], dry_evidence: 'app.js:1 inspected' },
      ],
    },
    { ticket: 'T1', cwd: repo, revision: rev }
  );

  assert.equal(res.status, 'pass', JSON.stringify(res));
  assert.equal(realpathSync(process.cwd()), realpathSync(outsideCwd));
});
