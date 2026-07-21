// #244 end-to-end: drive the real rails-guard binary over a real git repo to prove
// the staged-then-reverted rail bypass is closed.
//
// rails-guard resolved changed files with a base-vs-working-tree diff (two-dot, no
// --cached), so a rail edit could be STAGED and then reverted in the working tree:
// `git diff <base>` saw nothing and the gate passed, while `git commit` would still
// record the staged violation. The changed-file set now unions the index, so a path
// differing from base in EITHER place is a rail edit. This proves the whole gate —
// git plumbing, resolver, exit codes — on the exact scenario from the issue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rails-guard.mjs');
const RAIL = 'packages/build-gate/**';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rg-244-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@test.invalid');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'packages', 'build-gate', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'build-gate', 'lib', 'tier.mjs'), 'export const tier = 1;\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  const baseSha = run('rev-parse', 'HEAD').trim();
  return { dir, run, baseSha };
}

function guard(dir, base, rails) {
  return spawnSync(process.execPath, [BIN, '--base', base, '--rails', rails], {
    cwd: dir, encoding: 'utf8',
  });
}

test('a rail edit STAGED then reverted in the working tree still FAILS (#244)', () => {
  const { dir, run, baseSha } = makeRepo();
  try {
    const railed = join(dir, 'packages', 'build-gate', 'lib', 'tier.mjs');
    writeFileSync(railed, 'export const tier = 99;\n'); // behaviour change under the rail
    run('add', 'packages/build-gate/lib/tier.mjs');     // staged into the index
    writeFileSync(railed, 'export const tier = 1;\n');   // working tree restored to base
    // The bypass precondition: base-vs-worktree diff is empty, so the old two-dot
    // contract saw nothing. The commit would still record the staged violation.
    assert.equal(run('diff', '--name-only', baseSha, '--').trim(), '',
      'fixture must leave an empty base-vs-worktree diff');
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ordinary unstaged edit to a NON-railed file still PASSES (#244 no regression)', () => {
  const { dir, run } = makeRepo();
  try {
    // A tracked file OUTSIDE every rail, edited but never staged — the normal build
    // flow. It appears in the changed-file set, but not under the rail, so the gate
    // must still pass: consulting the index must not reject plain unstaged edits.
    mkdirSync(join(dir, 'packages', 'other', 'lib'), { recursive: true });
    const nonRailed = join(dir, 'packages', 'other', 'lib', 'thing.mjs');
    writeFileSync(nonRailed, 'export const x = 1;\n');
    run('add', '-A'); run('commit', '-q', '-m', 'add non-railed file');
    const base = run('rev-parse', 'HEAD').trim();
    writeFileSync(nonRailed, 'export const x = 2;\n'); // unstaged edit
    const res = guard(dir, base, RAIL);
    assert.equal(res.status, 0, `expected pass, got ${res.status}: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
