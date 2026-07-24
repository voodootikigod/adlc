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

  // Probe an existing worktree at the fixed path: is it usable, and is it on our branch?
  let onRightBranch = false;
  let probe = null;
  try {
    probe = gitAt(abs);
    onRightBranch = probe('symbolic-ref', '--short', 'HEAD') === integrationBranch;
  } catch { probe = null; /* not a usable worktree */ }

  // Resume: reuse a worktree already on the right branch — but NEVER a DIRTY one. A crash
  // between a completion's manifest append and its path-scoped commit can leave the worktree
  // dirty with an orphaned completion; reusing it could let a later completion sweep that
  // orphan into its own commit (a false attestation). We deliberately do NOT try to
  // classify orphan-vs-legitimate and auto-clean: every shape heuristic risks reverting real
  // recovery evidence or deleting a file that was never a disposable orphan. Instead we FAIL
  // CLOSED — refuse and let a human inspect. A dirty worktree is never reused, so an orphan
  // can never reach a commit; a clean worktree is reused directly.
  if (onRightBranch) {
    assertIntegrationWorktreeClean(abs, probe, `the resumed integration worktree (${integrationBranch})`);
    return { path: abs, created: false };
  }

  // Recreate: the fixed path is on another run's branch, detached, or unusable, so it must be
  // rebuilt. The integration worktree survives across runs and may hold a human's in-progress
  // recovery work, so a force-remove is only safe once we have PROVEN the path holds nothing
  // uncommitted. Fail closed on uncertainty:
  //   - absent path (nothing on disk)     → nothing to lose; fall through to prune + recreate.
  //   - readable worktree (probe worked)  → require a clean status (refuse if dirty), then remove.
  //   - EXISTS but UNREADABLE (probe null) → its git state can't be read (damaged .git, a
  //     permissions change, an interrupted git op), so we CANNOT prove it is empty of
  //     uncommitted work → REFUSE rather than blindly force-remove it.
  if (existsSync(abs)) {
    if (probe) {
      assertIntegrationWorktreeClean(abs, probe, `the existing integration worktree at ${INTEGRATION_WORKTREE}`);
    } else {
      throw new Error(
        `the integration worktree path ${abs} exists but its git state could not be read ` +
        `(damaged .git metadata, a permissions change, or an interrupted git operation). ` +
        `Refusing to force-remove it: it may hold uncommitted recovery work that cannot be ` +
        `recovered once deleted. Inspect it and remove it deliberately, then re-run (manual ` +
        `recovery required).`,
      );
    }
  }

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
 * Refuse (throw) if the integration worktree has ANY uncommitted change — tracked or
 * untracked. This is the fleet's fail-closed guard against silently destroying state: a
 * crash orphan and a human's manual recovery work are indistinguishable from a heuristic's
 * point of view, so we never auto-clean, revert, or force-remove a dirty worktree. The
 * caller must NOT swallow this — a throw here aborts the run so a human resolves the state.
 *
 * Callers only invoke this once they have established the worktree is readable (a resume on
 * the right branch, or a recreate whose probe succeeded). If `git status` nonetheless fails
 * here, the worktree's state is UNKNOWN — we fail closed and refuse, never assume it is safe
 * to reuse or delete (a fail-open assumption there could discard uncommitted recovery work).
 */
export function assertIntegrationWorktreeClean(worktreeAbs, wtGit, label) {
  let dirty;
  try { dirty = wtGit('status', '--porcelain').trim(); }
  catch (e) {
    throw new Error(
      `${label} could not be read (${e.message.trim()}). Refusing to reuse or force-remove ` +
      `it while its state is unknown — it may hold uncommitted recovery work. Inspect the ` +
      `worktree at ${worktreeAbs} and resolve it deliberately, then re-run (manual recovery ` +
      `required).`,
    );
  }
  if (dirty) {
    throw new Error(
      `${label} has uncommitted changes:\n${dirty}\n\n` +
      `Refusing to reuse or force-remove it. A fleet crash can leave an orphaned completion ` +
      `here, and this shared worktree may also hold manual recovery work — the two are not ` +
      `distinguishable automatically, so nothing is auto-cleaned. Inspect the worktree at ` +
      `${worktreeAbs}, commit or discard the changes deliberately, then re-run (manual ` +
      `recovery required).`,
    );
  }
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
