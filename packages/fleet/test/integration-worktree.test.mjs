// The integration branch lives in its OWN worktree, never in the shared main checkout.
//
// This is the structural close-out for a whole class of defects: every integration step
// used to `git checkout <integrationBranch>` in the shared repo and then act on ambient
// HEAD, so an external process could move it mid-operation and merges, gates,
// completions and withdrawals could all be attributed to the wrong branch. Detection
// could only ever narrow that window. A dedicated worktree removes it: git REFUSES to
// check out a branch that is already checked out elsewhere, so the collision cannot
// occur in the first place.
//
// Driven against REAL git — a stub cannot demonstrate git's own refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureIntegrationWorktree, INTEGRATION_WORKTREE, defaultGit } from '../lib/worktrees.mjs';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-integ-wt-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=f@t', '-c', 'user.name=f', ...args], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('commit', '--allow-empty', '-q', '-m', 'root');
  return { root, git, baseSha: git('rev-parse', 'HEAD') };
}

test('the integration branch is checked out in its own worktree, not the main checkout', () => {
  const { root, git, baseSha } = makeRepo();
  try {
    const { path, created } = ensureIntegrationWorktree(root, 'fleet/run-x', { baseSha, git });

    assert.equal(created, true);
    assert.equal(path, join(root, INTEGRATION_WORKTREE));
    assert.ok(existsSync(path), 'the worktree exists on disk');
    assert.equal(defaultGit(path)('symbolic-ref', '--short', 'HEAD'), 'fleet/run-x', 'and has the integration branch checked out');
    // The shared checkout is untouched.
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main', 'the main checkout stays on its own branch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('git REFUSES to check out the integration branch in the shared checkout — the race becomes impossible', () => {
  const { root, git, baseSha } = makeRepo();
  try {
    ensureIntegrationWorktree(root, 'fleet/run-x', { baseSha, git });

    // This is the exact hostile action the previous design could not defend against:
    // an external process switching the shared checkout onto the integration branch
    // mid-run. Git itself now rejects it.
    assert.throws(
      () => git('checkout', 'fleet/run-x'),
      /already (used by|checked out)/i,
      'the shared checkout cannot take the integration branch while the worktree holds it',
    );
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main', 'so the main checkout never moved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a second call reuses the existing worktree (resume) instead of recreating it', () => {
  const { root, git, baseSha } = makeRepo();
  try {
    const first = ensureIntegrationWorktree(root, 'fleet/run-x', { baseSha, git });
    // Resume: no baseSha — attach to the branch that already exists.
    const again = ensureIntegrationWorktree(root, 'fleet/run-x', { git });

    assert.equal(again.created, false, 'the live worktree is reused, not rebuilt');
    assert.equal(again.path, first.path);
    assert.equal(defaultGit(again.path)('symbolic-ref', '--short', 'HEAD'), 'fleet/run-x');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a stale worktree directory is rebuilt rather than inherited', () => {
  const { root, git, baseSha } = makeRepo();
  try {
    ensureIntegrationWorktree(root, 'fleet/run-x', { baseSha, git });
    // Simulate a prior run's leftovers: the worktree is gone from disk but git may
    // still have it registered.
    rmSync(join(root, INTEGRATION_WORKTREE), { recursive: true, force: true });

    const rebuilt = ensureIntegrationWorktree(root, 'fleet/run-y', { baseSha, git });

    assert.equal(rebuilt.created, true, 'it rebuilds rather than trusting a stale directory');
    assert.equal(defaultGit(rebuilt.path)('symbolic-ref', '--short', 'HEAD'), 'fleet/run-y');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
