// Git worktree lifecycle for the fleet (spec §6.3, §9). Worktrees live in
// `.worktrees/`, one branch per ticket, cut from the integration-branch tip
// (NOT base, N3), merged sequentially rebase-first into the integration branch
// (NEVER base, §9). The revert path is HEAD-checked so it can never drop a
// commit that landed during a long post-merge gate (adversarial-review F4/N2).
//
// Every git call goes through an injectable runner so the merge/revert policy is
// unit-testable without a real repository.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function defaultGit(repo) {
  return (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Ensure the fleet's working dirs are gitignored (append once). */
export function ensureGitignore(repo, git = defaultGit(repo)) {
  const path = join(repo, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = current.split('\n');
  const want = ['.worktrees/', '.adlc/fleet-status.json', '.adlc/fleet-logs/', '.adlc/fleet.lock/'];
  const missing = want.filter((l) => !lines.includes(l));
  if (missing.length) {
    appendFileSync(path, (current.endsWith('\n') || current === '' ? '' : '\n') + missing.join('\n') + '\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'chore: gitignore fleet working dirs', '--', '.gitignore');
  }
}

/** Create/return the per-run integration branch at the base SHA. */
export function createIntegrationBranch(repo, integrationBranch, baseSha, git = defaultGit(repo)) {
  // Remove a leftover branch of the same name from a prior run, then create.
  try { git('branch', '-D', integrationBranch); } catch { /* none */ }
  git('branch', integrationBranch, baseSha);
  return integrationBranch;
}

/**
 * Create a worktree + branch for a ticket, cut from the current integration tip.
 * Returns { path, branch, startSha } — startSha is the integration tip the
 * ticket was cut from, the diff base for the scope/prosecution gates (N3).
 */
export function createWorktree(repo, ticketId, { integrationBranch, git = defaultGit(repo) }) {
  const id = ticketId.toLowerCase();
  const branch = `fleet/${id}`;
  const path = join('.worktrees', `fleet-${id}`);
  const startSha = git('rev-parse', integrationBranch);
  try { git('worktree', 'remove', '--force', path); } catch { /* none */ }
  try { git('branch', '-D', branch); } catch { /* none */ }
  git('worktree', 'add', '-b', branch, path, startSha);
  return { path: join(repo, path), branch, startSha };
}

/** Restore a worktree to its clean cut state between strikes (§6.3). */
export function resetWorktree(worktreePath, git = defaultGit(worktreePath)) {
  git('checkout', '--', '.');
  git('clean', '-fd');
}

/**
 * Commit the worker's changes. The pathspec deliberately EXCLUDES `.claude/` and
 * `.adlc/` (§6.3) so fleet-provisioned control files never enter the diff — the
 * protected-path integrity scan (§8.3d) covers those separately.
 */
export function commitWorker(worktreePath, ticketId, git = defaultGit(worktreePath)) {
  git('add', '-A', '--', ':!.claude', ':!.adlc');
  git('commit', '-q', '-m', `feat(${ticketId}): fleet worker build`);
  return git('rev-parse', 'HEAD');
}

/**
 * Rebase the ticket branch onto the current integration tip and merge it in.
 * Returns { mergeSha, preMergeSha }. Throws on rebase conflict (caller treats it
 * as a strike — conflicts were scheduled away by scope serialization; one
 * appearing means the plan lied, not something to auto-resolve).
 */
export function mergeToIntegration(repo, branch, integrationBranch, git = defaultGit(repo)) {
  const preMergeSha = git('rev-parse', integrationBranch);
  git('rebase', integrationBranch, branch);
  git('checkout', integrationBranch);
  git('merge', '--no-ff', '--no-edit', branch);
  const mergeSha = git('rev-parse', integrationBranch);
  return { mergeSha, preMergeSha };
}

/**
 * Revert a merge whose post-merge gate failed — WITHOUT ever dropping unrelated
 * work (adversarial-review F4/N2). Only resets to `preMergeSha` if the
 * integration branch HEAD is STILL exactly the merge commit the fleet created;
 * if HEAD moved (a concurrent local commit), it refuses to reset and falls back
 * to `git revert`, which is safe under a moved HEAD.
 *
 * @returns { method:'reset'|'revert'|'refused', ok:boolean, reason?:string }
 */
export function revertMerge(repo, integrationBranch, { mergeSha, preMergeSha }, git = defaultGit(repo)) {
  const head = git('rev-parse', integrationBranch);
  if (head === mergeSha) {
    git('reset', '--hard', preMergeSha);
    return { method: 'reset', ok: true };
  }
  // HEAD moved: a blind reset would discard the intervening commit. Revert the
  // known merge commit instead (creates a new commit; loses nothing).
  try {
    git('revert', '--no-edit', '-m', '1', mergeSha);
    return { method: 'revert', ok: true, reason: 'integration HEAD moved during gate; used git revert to avoid dropping unrelated work' };
  } catch (e) {
    return { method: 'refused', ok: false, reason: `integration HEAD moved and git revert failed (${e.message}); manual recovery required` };
  }
}

export function removeWorktree(repo, worktreePath, git = defaultGit(repo)) {
  try { git('worktree', 'remove', '--force', worktreePath); } catch { /* already gone */ }
}

export function pruneWorktrees(repo, git = defaultGit(repo)) {
  try { git('worktree', 'prune'); } catch { /* best effort */ }
}

/** Abort any in-progress rebase/merge left by a dead run (§6.4). */
export function abortInProgress(repo, git = defaultGit(repo)) {
  try { git('rebase', '--abort'); } catch { /* none */ }
  try { git('merge', '--abort'); } catch { /* none */ }
}
