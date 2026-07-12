// Resume reconciliation wiring (spec §6.4; adversarial-review N2). On startup
// with an existing status, git is the source of truth: a ticket whose branch is
// an ancestor of the RECORDED integration branch counts as merged (not base —
// base is never written), others return to pending. Refuses if the recorded run
// anchors (integrationBranch / baseSha) are missing or gone, rather than
// guessing. Injectable git so it is unit-testable.

import * as worktrees from './worktrees.mjs';
import { reconcileResume } from './scheduler.mjs';

/**
 * @returns { resume:false } (nothing to resume) |
 *          { resume:false, refused:true, reason } (anchors invalid) |
 *          { resume:true, status } (reconciled status, safe to continue)
 */
export function reconcileRun({ all, status, repo, io }) {
  if (!status) return { resume: false };
  const git = io.git(repo);
  const ib = status.integrationBranch;
  if (!ib) return { resume: false, refused: true, reason: 'recorded status has no integration branch' };

  // The integration branch must still exist (N2): successful work lives on it.
  try { git('rev-parse', '--verify', ib); }
  catch { return { resume: false, refused: true, reason: `integration branch ${ib} is missing/deleted — cannot safely resume; start a fresh run` }; }

  // The recorded base SHA must still be a reachable object.
  if (status.baseSha) {
    try { git('cat-file', '-e', `${status.baseSha}^{commit}`); }
    catch { return { resume: false, refused: true, reason: `recorded baseSha ${status.baseSha} is gone — cannot safely resume` }; }
  }

  // Abort any half-finished git operation a dead run left behind, prune stale worktrees.
  worktrees.abortInProgress(repo, git);
  worktrees.pruneWorktrees(repo, git);

  const isAncestor = (branch, ref) => {
    try { git('merge-base', '--is-ancestor', branch, ref); return true; }
    catch { return false; }
  };
  const reconciled = reconcileResume(all, status, { isAncestor, integrationBranch: ib });
  return { resume: true, status: reconciled };
}
