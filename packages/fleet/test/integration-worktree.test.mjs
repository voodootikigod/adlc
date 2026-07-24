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
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureIntegrationWorktree, INTEGRATION_WORKTREE, defaultGit } from '../lib/worktrees.mjs';
import { runFleet } from '../lib/run.mjs';
import { resolveRunConfig } from '../lib/config.mjs';

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

test('RESUME re-attaches a missing integration worktree before any work is dispatched', async () => {
  // A resumed run continues an existing integration branch, but its worktree may have
  // been removed by cleanup or a crash — and every integration step now needs it. The
  // re-attach must happen BEFORE dispatch, or the run burns worker time on tickets that
  // cannot possibly merge.
  const { root, git, baseSha } = makeRepo();
  try {
    ensureIntegrationWorktree(root, 'fleet/run-r', { baseSha, git });
    const priorSha = defaultGit(join(root, INTEGRATION_WORKTREE))('rev-parse', 'HEAD');
    // The worktree vanishes; the BRANCH survives (this is what resume must cope with).
    rmSync(join(root, INTEGRATION_WORKTREE), { recursive: true, force: true });
    git('worktree', 'prune');
    assert.ok(!existsSync(join(root, INTEGRATION_WORKTREE)), 'precondition: worktree gone');
    assert.equal(git('rev-parse', 'fleet/run-r'), priorSha, 'precondition: branch survives');

    const order = [];
    const deps = {
      baseSha: 'BASE',
      ensureIntegrationWorktree: ({ integrationBranch }) => {
        order.push('ensure');
        return ensureIntegrationWorktree(root, integrationBranch, { git });
      },
      createWorktree: ({ ticket }) => { order.push('dispatch-setup'); return { path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }; },
      dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
      gate: () => ({ ok: true }),
      prosecute: () => ({ verdict: 'pass' }),
      flail: () => ({ flail: false }),
      mergeToIntegration: () => ({ mergeSha: 'M', preMergeSha: 'P' }),
      postMergeGate: () => ({ ok: true }),
      revertMerge: () => ({ method: 'reset', ok: true }),
      openPR: () => {},
    };
    const status = { runId: 'r', base: 'main', baseSha: 'BASE', integrationBranch: 'fleet/run-r', concurrency: 1, tickets: {} };
    await runFleet({
      all: [{ id: 'T1', title: 'T1', scope: ['src/T1/**'], edges: [] }],
      runId: 'r',
      config: { ...resolveRunConfig({}, {}), baseSha: 'BASE' },
      deps,
      resume: { status, integrationBranch: 'fleet/run-r' },
    });

    assert.ok(existsSync(join(root, INTEGRATION_WORKTREE)), 'the worktree is restored on resume');
    assert.equal(defaultGit(join(root, INTEGRATION_WORKTREE))('symbolic-ref', '--short', 'HEAD'), 'fleet/run-r');
    assert.equal(git('rev-parse', 'fleet/run-r'), priorSha, 'and the branch history is preserved, not reset to base');
    assert.equal(order[0], 'ensure', 'the re-attach happens BEFORE any ticket work is set up');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RESUME REFUSES a DIRTY integration worktree instead of auto-cleaning — nothing is destroyed', () => {
  // A crash between a completion's manifest append and its commit leaves the worktree dirty
  // with an orphaned completion. But a human investigating a wedged run leaves dirty state
  // too — recovery edits, diagnostics. The two are NOT distinguishable by any shape heuristic,
  // so the fleet does not guess: it refuses to reuse a dirty worktree and destroys nothing.
  // (This is the fail-closed guarantee: a dirty worktree is never reused, so an orphaned
  // completion can never be swept into a later ticket's commit — without ever auto-reverting
  // or deleting a file that might be real evidence.)
  const { root, git } = makeRepo();
  try {
    mkdirSync(join(root, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets', 'T1--aaa.json'), '{"id":"T1","completed":false}\n');
    writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'seed shard + ledger');
    const baseSha = git('rev-parse', 'HEAD');

    const { path } = ensureIntegrationWorktree(root, 'fleet/run-r', { baseSha, git });
    const wtGit = defaultGit(path);
    const headBefore = wtGit('rev-parse', 'HEAD');

    // Dirty the worktree: an orphaned manifest append, a shard edit, and an untracked file.
    writeFileSync(join(path, '.adlc', 'manifest.jsonl'), '{"seq":1}\n{"seq":2,"orphan":true}\n');
    writeFileSync(join(path, '.adlc', 'tickets', 'T1--aaa.json'), '{"id":"T1","completed":true}\n');
    writeFileSync(join(path, 'recovery-notes.txt'), 'operator was here\n');

    // Resume (no baseSha — attach to the existing branch) MUST refuse, not auto-clean.
    assert.throws(
      () => ensureIntegrationWorktree(root, 'fleet/run-r', { git }),
      /uncommitted changes|manual recovery required/i,
      'a dirty integration worktree is refused on resume, not silently reconciled',
    );
    // Every dirty artifact is left EXACTLY as found — nothing reverted, nothing deleted.
    assert.equal(readFileSync(join(path, '.adlc', 'manifest.jsonl'), 'utf8'), '{"seq":1}\n{"seq":2,"orphan":true}\n', 'the ledger is untouched (not auto-reverted)');
    assert.equal(readFileSync(join(path, '.adlc', 'tickets', 'T1--aaa.json'), 'utf8'), '{"id":"T1","completed":true}\n', 'the shard is untouched');
    assert.ok(existsSync(join(path, 'recovery-notes.txt')), 'untracked recovery work is preserved');
    assert.equal(wtGit('rev-parse', 'HEAD'), headBefore, 'the committed history is preserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a NEW run REFUSES to force-remove a DIRTY integration worktree left on another run\'s branch', () => {
  // The integration worktree survives across runs. A later run wants the path for its OWN
  // integration branch, so the fixed path is on the wrong branch and the reuse guard does not
  // apply. The old code fell straight through to `git worktree remove --force`, destroying any
  // uncommitted work in it WITHOUT checking (adversarial-review round-28, high/0.98). The
  // recreate path must therefore also refuse a dirty worktree rather than force-remove it.
  const { root, git, baseSha } = makeRepo();
  try {
    const { path } = ensureIntegrationWorktree(root, 'fleet/run-1', { baseSha, git });
    // A human left uncommitted recovery work in run-1's integration worktree.
    writeFileSync(join(path, 'run-1-recovery.txt'), 'do not delete me\n');

    // A NEW run (different integration branch) must NOT force-remove that dirty worktree.
    assert.throws(
      () => ensureIntegrationWorktree(root, 'fleet/run-2', { baseSha, git }),
      /uncommitted changes|manual recovery required/i,
      'a dirty worktree on another branch is refused, not force-removed',
    );
    assert.ok(existsSync(join(path, 'run-1-recovery.txt')), 'the prior run\'s uncommitted work survives — not force-deleted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a NEW run REFUSES to force-remove an integration worktree whose git state is UNREADABLE', () => {
  // The path exists but its git metadata cannot be read (damaged .git, a permissions change,
  // an interrupted git op), so the branch/status probe throws. That is precisely the state
  // where we cannot prove the worktree is empty of uncommitted work — force-removing it would
  // destroy recovery edits we simply could not read (adversarial-review round-29, high/0.88).
  // Fail closed: refuse, do not force-remove.
  const { root, git, baseSha } = makeRepo();
  try {
    const { path } = ensureIntegrationWorktree(root, 'fleet/run-1', { baseSha, git });
    writeFileSync(join(path, 'unreadable-recovery.txt'), 'precious and unreadable\n');

    // Simulate unreadable git metadata: every git command in the worktree throws.
    const throwingGitAt = () => () => { throw new Error('fatal: not a git repository (damaged .git)'); };

    assert.throws(
      () => ensureIntegrationWorktree(root, 'fleet/run-2', { baseSha, git, gitAt: throwingGitAt }),
      /could not be read|manual recovery required/i,
      'an existing-but-unreadable worktree is refused, not force-removed',
    );
    assert.ok(existsSync(join(path, 'unreadable-recovery.txt')), 'uncommitted recovery work survives — the unreadable worktree was not force-deleted');
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
