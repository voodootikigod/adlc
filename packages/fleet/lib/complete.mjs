// T73 — mark a ticket completed on the integration branch after its post-merge
// gate passes, so the single PR the fleet already opens carries the add-only
// `completed:true` annotation (nothing in the ADLC lifecycle set it before, so
// shipped tickets accumulated open).
//
// Completion goes through the SAME TicketService.planComplete + apply path the
// `adlc ticket complete` CLI uses, so it records manifest evidence exactly like a
// human completion (spec: "go through the existing planComplete path"). The git
// runner is injected (like worktrees.mjs) so the whole thing is unit-testable.
//
// The integration branch is expected to be checked out at `repo` (the merge
// choreography checks it out for the post-merge gate immediately before this
// runs, all under the merge mutex), so a commit here lands on that branch.

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withLedgerLock } from '@adlc/core';
import { ACTIVE_DIRECTORY, DirectoryTicketStore, LEGACY_FILE, detectTicketStore, TicketService, ticketFilename, acquireTicketLock, releaseTicketLock } from '@adlc/tickets';
import { defaultGit } from './worktrees.mjs';

const MANIFEST_FILE = '.adlc/manifest.jsonl';

/** Repo-relative path of the store artifact a completion of `id` rewrites. */
function completionStorePath(store, id) {
  return store instanceof DirectoryTicketStore ? `${ACTIVE_DIRECTORY}/${ticketFilename(id)}` : LEGACY_FILE;
}

/**
 * Assert the shared checkout is on `branch` and HEAD points at it.
 *
 * NOTE ON THE RESIDUAL RACE: nothing we can lock stops an external process from
 * running `git checkout` in a shared checkout — the ticket and manifest locks do not
 * serialize git's own refs. So this is checked at entry AND again immediately before
 * the commit (narrowing the window to that call), with a post-commit verification to
 * DETECT a switch we could not prevent. The complete fix is not to share the checkout
 * at all — give the integration branch a dedicated worktree. Tracked as follow-up.
 */
export function assertOnBranch(git, branch, when, action = 'complete') {
  const current = git('symbolic-ref', '--short', 'HEAD'); // throws on detached HEAD — fail closed
  if (current !== branch) {
    throw new Error(`refusing to ${action} (${when}): checkout is on "${current}", not the integration branch "${branch}"`);
  }
  if (git('rev-parse', 'HEAD') !== git('rev-parse', branch)) {
    throw new Error(`refusing to ${action} (${when}): HEAD does not point at "${branch}"`);
  }
}

/** Restore a file to captured bytes (or delete it if it did not exist before). */
function restoreFile(absPath, priorBytes) {
  if (priorBytes === null) { if (existsSync(absPath)) rmSync(absPath); }
  else writeFileSync(absPath, priorBytes);
}

/**
 * Withdraw the completion commit, returning the integration branch to `toSha`.
 * Used when the gate re-run over the completion commit fails: the shipped merge
 * below it stays intact, only the completion annotation is withdrawn.
 *
 * Deliberately NOT a checkout-wide `reset --hard`: this runs in the SHARED
 * integration checkout, so a hard reset would destroy unrelated tracked work. HEAD
 * moves back with --soft and only this completion's own paths are discarded.
 *
 * The manifest is treated differently from the shard: it is a shared, append-only
 * evidence ledger whose appends are serialized by the LEDGER lock, not the ticket
 * lock — a concurrent recorder may have appended since. So the manifest is only
 * UNSTAGED (its bytes are left on disk); restoring it to `toSha` would erase that
 * concurrent evidence. An extra append-only evidence line is harmless; losing
 * another writer's evidence is not.
 */
export function revertCompletionCommit({ repo, toSha, shardPath = null, completionSha = null, integrationBranch, git = defaultGit(repo) } = {}) {
  // Branch IDENTITY, not just commit identity. A SHA match alone is insufficient:
  // another branch can legitimately point at the completion commit, so if the shared
  // checkout switched to one of those, every SHA precondition below would pass and the
  // `reset --soft` would rewind THAT branch — leaving the rejected completion sitting
  // on the integration branch. Same guard completeTicketOnIntegration uses.
  if (!integrationBranch) throw new Error('revertCompletionCommit requires integrationBranch to verify the checkout before rewinding');
  // Withdrawal is EXACT or it does not happen. Two preconditions, both checked against
  // the shared checkout as it is RIGHT NOW:
  //   1. HEAD is still our completion commit. Otherwise a --soft reset would silently
  //      uncommit whatever another process committed on this shared branch.
  //   2. The evidence ledger has not been appended to since our commit. Otherwise we
  //      would have to choose between erasing a concurrent writer's evidence and
  //      leaving a REJECTED completion's attestation on disk — where a later
  //      completion's `git add` would sweep it into an unrelated commit, making the
  //      ledger falsely attest a completion that was withdrawn.
  // Failing either, we refuse. The caller escalates a refusal to a branch quarantine,
  // which is the honest outcome: this branch needs a human, not more blind surgery.
  // Reacquire the TICKET lock for the withdrawal. completeTicketOnIntegration released
  // it when it returned, and the caller then ran a potentially long post-completion
  // gate — during which a legal non-sensitive ticket update can land (such updates
  // record no manifest evidence, so the ledger check below cannot see them). Restoring
  // the shard without this lock would silently erase that update.
  const lock = acquireTicketLock(repo, { command: 'fleet:withdraw-completion' });
  try {
  assertOnBranch(git, integrationBranch, 'before rewinding', 'withdraw');
  const head = git('rev-parse', 'HEAD');
  if (completionSha && head !== completionSha) {
    throw new Error(`refusing to withdraw: HEAD is ${head}, no longer the completion commit ${completionSha} — another process committed on this branch`);
  }
  if (completionSha && git('rev-parse', integrationBranch) !== completionSha) {
    throw new Error(`refusing to withdraw: "${integrationBranch}" no longer points at the completion commit ${completionSha}`);
  }
  const committedManifest = git('show', `${head}:${MANIFEST_FILE}`);
  const manifestAbs = join(repo, MANIFEST_FILE);

  // The ledger comparison and the restore that acts on it MUST be one critical
  // section. Checking first and restoring after leaves a window in which a recorder
  // appends between the two — the restore then rewrites the ledger to the
  // pre-completion version and silently destroys that evidence. Hold the manifest
  // lock across BOTH. Lock order is ticket → manifest everywhere, matching the
  // transaction layer, so this cannot deadlock against a concurrent recorder.
  return withLedgerLock(manifestAbs, () => {
    const liveManifest = existsSync(manifestAbs) ? readFileSync(manifestAbs, 'utf8').trimEnd() : '';
    if (liveManifest !== committedManifest.trimEnd()) {
      throw new Error('refusing to withdraw: the evidence ledger changed since the completion commit (concurrent append) — cannot remove our entry without disturbing another writer');
    }
    // Same exactness rule for the SHARD: it must still be byte-for-byte what the
    // completion commit recorded. A concurrent non-sensitive update leaves no evidence
    // trail, so this content check is the only thing standing between a withdrawal and
    // silently reverting someone else's legitimate edit.
    if (shardPath) {
      const committedShard = git('show', `${head}:${shardPath}`);
      const shardAbs = join(repo, shardPath);
      const liveShard = existsSync(shardAbs) ? readFileSync(shardAbs, 'utf8').trimEnd() : '';
      if (liveShard !== committedShard.trimEnd()) {
        throw new Error('refusing to withdraw: the ticket shard changed since the completion commit (concurrent update) — restoring would erase it');
      }
    }

    // Preconditions hold AND neither a recorder nor a ticket writer can interleave
    // while we hold both locks, so restore both owned paths exactly. Still
    // path-scoped — never a checkout-wide reset --hard.
    git('reset', '-q', '--soft', toSha);
    const paths = shardPath ? [shardPath, MANIFEST_FILE] : [MANIFEST_FILE];
    git('restore', '--staged', '--worktree', '--', ...paths);
    return { reverted: true, toSha };
  });
  } finally { releaseTicketLock(lock); }
}

/**
 * Complete `ticketId` in the ticket store rooted at `repo` and commit the
 * add-only diff onto the currently checked-out (integration) branch.
 *
 * Idempotent: an already-completed ticket is a no-op — no planComplete, no
 * apply, no commit, no spurious evidence entry, and never an error. A ticket
 * that is not in the store is likewise a no-op (reported, not thrown), so the
 * caller — a best-effort post-merge step — never reverts a good, shipped merge.
 *
 * @returns {{completed: boolean, alreadyComplete?: boolean, reason?: string}}
 */
export function completeTicketOnIntegration({ repo, ticketId, integrationBranch, git = defaultGit(repo), detectStore = detectTicketStore } = {}) {
  // Every git operation below targets the SHARED checkout's current HEAD. The merge
  // mutex serializes only this fleet process — another local process can change the
  // checkout between the post-merge gate and here — so verify we are actually on the
  // integration branch BEFORE any mutation, rather than trusting the caller's
  // choreography. Without this a lifecycle commit can land on the wrong branch.
  if (!integrationBranch) throw new Error('completeTicketOnIntegration requires integrationBranch to verify the checkout before mutating');
  assertOnBranch(git, integrationBranch, 'before mutating');

  const store = detectStore({ root: repo });
  const storePath = completionStorePath(store, ticketId);
  const storeAbs = join(repo, storePath);
  const manifestAbs = join(repo, MANIFEST_FILE);

  // Hold the ticket writer lock across the ENTIRE completion — the read, the
  // transaction, the commit, and any rollback. The transaction alone releases the
  // lock as soon as it returns, which would let another ticket/manifest writer
  // interleave before the commit; a failed-commit rollback (which rewrites the whole
  // shard + manifest back to pre-completion bytes) could then clobber that writer's
  // committed state. Holding one lock over the whole unit makes it atomic. `apply`
  // reuses this lock and does NOT release it (we release in finally).
  const lock = acquireTicketLock(repo, { command: `fleet:complete:${ticketId}` });
  try {
    const existing = store.load().get(ticketId);
    if (!existing) return { completed: false, reason: 'ticket-not-found' };
    // Idempotency: an already-completed ticket short-circuits — a no-change complete
    // still records evidence and would leave an empty commit.
    if (existing.completed === true) return { completed: false, alreadyComplete: true };

    // Capture pre-completion bytes (BEFORE the transaction writes them) so a failed
    // commit rolls back precisely.
    const priorStore = existsSync(storeAbs) ? readFileSync(storeAbs) : null;
    const priorManifest = existsSync(manifestAbs) ? readFileSync(manifestAbs) : null;

    // rails-guard-ci DENIES a PR that CREATES .adlc/manifest.jsonl with evidence
    // (only a verified migration may); appending to an existing one is allowed. On a
    // repo whose ADLC manifest is not yet bootstrapped, recording completion evidence
    // here would create the ledger and get the whole fleet PR rejected. Skip
    // auto-completion in that case and degrade to "merged, not yet completed".
    if (priorManifest === null) return { completed: false, reason: 'no-manifest-baseline' };

    // The tip BEFORE the completion commit — the caller re-gates the new commit and
    // rolls back to exactly here if that gate fails.
    const preCompletionSha = git('rev-parse', 'HEAD');

    const service = new TicketService(store, { root: repo });
    service.apply(service.planComplete(ticketId), { lock });
    // What the manifest looks like immediately after OUR append — the baseline for
    // detecting a concurrent evidence append before any rollback.
    const afterManifest = existsSync(manifestAbs) ? readFileSync(manifestAbs) : null;

    // Commit ONLY the completion artifacts (the shard/legacy file + the evidence
    // ledger). A path-scoped add + commit never sweeps in unrelated build output.
    let committed = false;
    try {
      // Re-verify immediately before staging/committing: an external checkout switch
      // between entry and here would otherwise land this lifecycle commit on whatever
      // branch is now current. This narrows the unpreventable window to these calls.
      assertOnBranch(git, integrationBranch, 'before committing');
      git('add', '--', storePath, MANIFEST_FILE);
      git('commit', '-q', '-m', `chore(${ticketId}): mark completed after passing merge gate`, '--', storePath, MANIFEST_FILE);
      committed = true;
      // DETECT the switch we cannot prevent. Note this can only fail AFTER the commit
      // landed, which is a materially different situation from a failed commit.
      assertOnBranch(git, integrationBranch, 'after committing');
    } catch (error) {
      if (committed) {
        // The commit LANDED and then the checkout moved under us. Two consequences, and
        // neither is a "degrade quietly" case:
        //   - We must NOT restore any path: we no longer know which branch is checked
        //     out, so writing files here would corrupt an unrelated checkout.
        //   - The caller's post-completion re-gate never runs (we are throwing), so an
        //     UNGATED completion commit is sitting on the integration branch. Left as a
        //     plain error it would be logged and swallowed, and the run could still open
        //     a PR carrying it.
        // Flag contamination so the run quarantines the branch instead of publishing it.
        error.branchContaminated = true;
        throw error;
      }
      // A failed commit (e.g. a rejecting hook) must NOT leave the shared integration
      // checkout dirty. Restore the two owned paths to their exact pre-completion
      // bytes and unstage them, then re-throw so the caller degrades to "merged, not
      // yet completed". Safe under the held lock — no other writer can have touched
      // these paths since we captured them.
      // The shard is covered by the ticket lock we hold, so restoring it is exact.
      restoreFile(storeAbs, priorStore);
      // The ledger is NOT: its appends are serialized by the MANIFEST lock, which the
      // ticket lock does not cover. Take that lock and undo our append only if it is
      // still the tail. If a concurrent recorder appended meanwhile we cannot remove
      // ours without disturbing theirs — and leaving it would let a later completion's
      // `git add` commit an attestation that THIS ticket completed, when we just
      // restored it to open. Undo is exact or we refuse: flag the ledger dirty and let
      // the caller quarantine the branch (same rule as revertCompletionCommit).
      // Lock order is ticket → manifest here, matching the transaction layer, so this
      // cannot deadlock against a concurrent recorder.
      let ledgerDirty = false;
      withLedgerLock(manifestAbs, () => {
        const now = existsSync(manifestAbs) ? readFileSync(manifestAbs) : null;
        const stillOurTail = now !== null && afterManifest !== null && now.equals(afterManifest);
        if (stillOurTail) restoreFile(manifestAbs, priorManifest);
        else ledgerDirty = true;
      });
      try { git('reset', '-q', '--', storePath, MANIFEST_FILE); } catch { /* best-effort unstage */ }
      if (ledgerDirty) error.ledgerDirty = true;
      throw error;
    }

    // The exact commit we created — the withdrawal path requires HEAD to still be
    // this, so it can never uncommit someone else's work.
    const completionSha = git('rev-parse', 'HEAD');
    return { completed: true, preCompletionSha, completionSha, shardPath: storePath };
  } finally {
    releaseTicketLock(lock);
  }
}
