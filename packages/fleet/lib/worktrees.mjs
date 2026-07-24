// Git worktree lifecycle for the fleet (spec §6.3, §9). Worktrees live in
// `.worktrees/`, one branch per ticket, cut from the integration-branch tip
// (NOT base, N3), merged sequentially rebase-first into the integration branch
// (NEVER base, §9). The revert path is HEAD-checked so it can never drop a
// commit that landed during a long post-merge gate (adversarial-review F4/N2).
//
// Every git call goes through an injectable runner so the merge/revert policy is
// unit-testable without a real repository.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_FILE } from '@adlc/tickets';

// The evidence ledger every completion appends to (mirrors complete.mjs's MANIFEST_FILE).
const MANIFEST_FILE = '.adlc/manifest.jsonl';

/**
 * The completion commits path-scoped: `git commit -- <its-shard> .adlc/manifest.jsonl`.
 * That means the ONLY completion-owned files another ticket's commit can accidentally
 * capture are the ones EVERY completion names and that ACCUMULATE across tickets — the
 * SHARED files. A per-ticket shard is private to its own completion's pathspec, so a
 * dirty orphan shard can never ride onto another ticket's commit and must be left alone
 * on resume (reverting the whole shard directory would destroy an operator's unrelated
 * in-flight edit). The shared, contamination-prone files are:
 *   - the manifest ledger — always in the pathspec; a crash orphan appends to it, and
 *     that append is a provable, disposable shape we can safely revert; and
 *   - the legacy single-file store — every ticket lives in this one file, so in a
 *     pre-shard repo it is shared too; its orphan shape is NOT distinguishable from a
 *     legitimate edit, so a dirty one is refused (never auto-destroyed).
 */
const SHARED_COMPLETION_FILES = { manifest: MANIFEST_FILE, legacyStore: LEGACY_FILE };

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
  // completion commit, leaves the worktree DIRTY with an orphaned completion. Reusing
  // that as-is could let a later ticket's completion stage and commit the orphaned SHARED
  // ledger append alongside its own — a false attestation that the crashed ticket
  // completed. We reconcile that ONE contamination vector and nothing else (see
  // reconcileResumeOrphan): shards and unrelated work are never touched.
  //
  // Determine "on the right branch" inside a guarded probe, but run the reconciliation
  // OUTSIDE it — a reconcile that refuses (throws) must ABORT the resume, not fall through
  // to the recreate path below, which would `--force`-remove the worktree and destroy the
  // very dirty state a human needs for recovery.
  let wtGit = null;
  try {
    const probe = gitAt(abs);
    if (probe('symbolic-ref', '--short', 'HEAD') === integrationBranch) wtGit = probe;
  } catch { /* not a usable worktree — fall through and (re)create */ }
  if (wtGit) {
    reconcileResumeOrphan(abs, wtGit);
    return { path: abs, created: false };
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
 * Neutralize a crash orphan in the resumed integration worktree WITHOUT destroying any
 * work we cannot prove is a disposable orphan.
 *
 * Scope is deliberately minimal (see SHARED_COMPLETION_FILES): the manifest ledger is the
 * only file a later ticket's path-scoped completion commit can accidentally capture, so it
 * is the only file we ever revert — and only when its dirty delta has the provable shape of
 * a crash orphan. Everything else (per-ticket shards, untracked diagnostics, an operator's
 * unrelated edits) is left exactly as found.
 *
 *  - Manifest UNTRACKED (never committed): the whole file is an uncommitted orphan; remove
 *    it (no committed evidence exists to lose).
 *  - Manifest TRACKED and dirty as a pure APPEND on top of HEAD: the crash-orphan shape;
 *    revert to HEAD, dropping the orphaned append.
 *  - Manifest dirty any OTHER way, or the legacy single-file store dirty at all: we cannot
 *    prove a benign orphan, so REFUSE — throw to abort the resume for manual recovery
 *    rather than silently destroy state. (The caller does NOT swallow this into recreate.)
 */
export function reconcileResumeOrphan(worktreeAbs, wtGit) {
  const { manifest, legacyStore } = SHARED_COMPLETION_FILES;

  const manifestStatus = wtGit('status', '--porcelain', '--', manifest).trim();
  if (manifestStatus) {
    if (manifestStatus[0] === '?') {
      // Untracked: entirely uncommitted → removing it drops the orphan and only the orphan.
      rmSync(join(worktreeAbs, manifest), { force: true });
    } else if (manifestIsAppendOrphan(worktreeAbs, wtGit, manifest)) {
      wtGit('checkout', 'HEAD', '--', manifest);
    } else {
      throw new Error(
        `integration worktree ${manifest} diverged from HEAD in a non-append shape on ` +
        `resume; cannot prove a benign crash orphan — refusing to reuse (manual recovery ` +
        `required so no committed evidence is silently discarded)`,
      );
    }
  }

  // The legacy single-file store is shared across every ticket, so an orphan and a
  // legitimate edit are indistinguishable in it. Never auto-destroy — refuse.
  if (wtGit('status', '--porcelain', '--', legacyStore).trim()) {
    throw new Error(
      `integration worktree ${legacyStore} is dirty on resume; the legacy single-file ` +
      `store cannot be proven a crash orphan (all tickets share the file) — refusing to ` +
      `reuse (manual recovery required)`,
    );
  }
}

/**
 * True iff the working manifest is exactly the committed ledger plus zero-or-more appended
 * lines — the shape a crash between append and commit leaves. Compared line-by-line so a
 * trailing-newline difference does not matter. A working copy that is NOT a superset-prefix
 * of HEAD (rewritten or truncated lines) is NOT an append orphan.
 */
function manifestIsAppendOrphan(worktreeAbs, wtGit, manifest) {
  let committed;
  try { committed = wtGit('show', `HEAD:${manifest}`); }
  catch { return false; } // not in HEAD → no committed baseline to append onto
  const working = readFileSync(join(worktreeAbs, manifest), 'utf8');
  const committedLines = committed.split('\n').filter((l) => l !== '');
  const workingLines = working.split('\n').filter((l) => l !== '');
  return (
    workingLines.length >= committedLines.length &&
    committedLines.every((line, i) => workingLines[i] === line)
  );
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
