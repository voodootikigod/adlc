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
import { ACTIVE_DIRECTORY, LEGACY_FILE } from '@adlc/tickets';

// The evidence ledger the completion appends to (mirrors complete.mjs's MANIFEST_FILE).
const MANIFEST_FILE = '.adlc/manifest.jsonl';

/**
 * The ONLY paths a crashed completion can leave dirty in the integration worktree:
 * the ticket store (sharded dir OR legacy file, whichever this repo uses) and the
 * evidence ledger. Imported from @adlc/tickets so the store layout stays authoritative
 * and cannot drift out from under the resume-cleanup scope. Used to bound the resume
 * cleanup so it never touches untracked diagnostics or unrelated work.
 */
export const INTEGRATION_OWNED_PATHS = [ACTIVE_DIRECTORY, LEGACY_FILE, MANIFEST_FILE];

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

/** Repo-relative path of the run's dedicated integration worktree. */
export const INTEGRATION_WORKTREE = join('.worktrees', 'fleet-integration');

/**
 * Give the integration branch its OWN worktree, so no integration-branch operation
 * ever runs in the shared main checkout.
 *
 * This is a correctness boundary, not a convenience. Every integration step used to
 * `git checkout <integrationBranch>` in the shared repo and then act on ambient HEAD,
 * which an external process could move at any moment — merges, gates, completions and
 * withdrawals could all be attributed to the wrong branch. A worktree has its own HEAD
 * and index, and git REFUSES to check out a branch that is already checked out in
 * another worktree, so the collision becomes impossible rather than merely detected.
 *
 * `baseSha` creates the branch fresh; omit it to attach to an existing branch (resume).
 */
export function ensureIntegrationWorktree(repo, integrationBranch, { baseSha = null, git = defaultGit(repo), gitAt = defaultGit } = {}) {
  const abs = join(repo, INTEGRATION_WORKTREE);
  // Resume: a live worktree already on the right branch is reused — but NOT blindly.
  // A crash after planComplete wrote the shard + manifest, yet before the path-scoped
  // completion commit, leaves the worktree DIRTY with orphaned completion artifacts.
  // Reusing that as-is would let a later ticket's completion stage and commit the
  // orphan alongside its own — a false attestation that the crashed ticket completed.
  // Everything legitimately merged lives in the branch's COMMITTED history, so we revert
  // the orphan before reusing — but scoped to the completion-owned paths only, never a
  // repo-wide reset that would also erase a human's untracked diagnostics or in-progress
  // recovery work in this shared worktree.
  try {
    const wtGit = gitAt(abs);
    if (wtGit('symbolic-ref', '--short', 'HEAD') === integrationBranch) {
      // Restore ONLY the completion-owned paths a crashed completion could have left
      // dirty — the ticket store and the evidence ledger. A repo-wide `reset --hard` +
      // `clean -fd` (the earlier fix) was too broad: it would also destroy untracked
      // diagnostic files or manual recovery work a human may have left in this shared
      // worktree while investigating a quarantined branch. `git checkout HEAD -- <path>`
      // reverts only tracked changes under that path; untracked and unrelated work is
      // untouched. Each path is restored independently so one absent from HEAD (e.g. the
      // legacy store file in a sharded repo) does not skip the others.
      if (wtGit('status', '--porcelain', '--', ...INTEGRATION_OWNED_PATHS).trim()) {
        for (const p of INTEGRATION_OWNED_PATHS) {
          try { wtGit('checkout', 'HEAD', '--', p); } catch { /* path may not exist in HEAD */ }
        }
      }
      return { path: abs, created: false };
    }
  } catch { /* not a usable worktree — fall through and (re)create */ }

  try { git('worktree', 'remove', '--force', INTEGRATION_WORKTREE); } catch { /* none */ }
  try { git('worktree', 'prune'); } catch { /* best effort */ }
  if (baseSha !== null) {
    try { git('branch', '-D', integrationBranch); } catch { /* none */ }
    git('worktree', 'add', '-b', integrationBranch, INTEGRATION_WORKTREE, baseSha);
  } else {
    git('worktree', 'add', INTEGRATION_WORKTREE, integrationBranch);
  }
  return { path: abs, created: true };
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
/**
 * Merge a ticket branch into the integration branch WITHOUT any checkout switching.
 *
 * Each branch is operated on in the worktree that already has it checked out: the
 * ticket branch rebases inside its own worktree, and the merge runs inside the
 * integration worktree. Nothing touches the shared main checkout, and no step depends
 * on ambient HEAD being what we last set it to.
 */
export function mergeToIntegration({ branch, integrationBranch, ticketGit, integrationGit }) {
  const preMergeSha = integrationGit('rev-parse', integrationBranch);
  ticketGit('rebase', integrationBranch); // the ticket branch is checked out here
  integrationGit('merge', '--no-ff', '--no-edit', branch);
  const mergeSha = integrationGit('rev-parse', integrationBranch);
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
  // HEAD moved: an intervening commit landed on top of our merge. Two truths hold at
  // once. (1) A blind reset would DISCARD that commit, so we revert our known merge
  // instead — the intervening commit is preserved (AC9/F4/N2). (2) But that intervening
  // commit was never covered by a passing gate, and reverting our merge does not remove
  // it. Treating this as clean recovery (ok:true) would carry an UNGATED commit into the
  // fleet PR. So the revert succeeds AND the branch is quarantined: ok:false, which the
  // caller routes to quarantine — no further merge lands, no PR opens. A human decides
  // what to do with the preserved-but-ungated commit.
  try {
    git('revert', '--no-edit', '-m', '1', mergeSha);
    return { method: 'revert', ok: false, reason: `integration HEAD moved to ${head} during the gate; our merge was reverted but the intervening commit is UNGATED — quarantined so it cannot reach the PR` };
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
