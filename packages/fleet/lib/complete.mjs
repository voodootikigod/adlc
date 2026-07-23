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
import { ACTIVE_DIRECTORY, DirectoryTicketStore, LEGACY_FILE, detectTicketStore, TicketService, ticketFilename, acquireTicketLock, releaseTicketLock } from '@adlc/tickets';
import { defaultGit } from './worktrees.mjs';

const MANIFEST_FILE = '.adlc/manifest.jsonl';

/** Repo-relative path of the store artifact a completion of `id` rewrites. */
function completionStorePath(store, id) {
  return store instanceof DirectoryTicketStore ? `${ACTIVE_DIRECTORY}/${ticketFilename(id)}` : LEGACY_FILE;
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
export function revertCompletionCommit({ repo, toSha, shardPath = null, git = defaultGit(repo) } = {}) {
  git('reset', '-q', '--soft', toSha);
  if (shardPath) git('restore', '--staged', '--worktree', '--', shardPath);
  git('restore', '--staged', '--', MANIFEST_FILE);
  return { reverted: true, toSha };
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
export function completeTicketOnIntegration({ repo, ticketId, git = defaultGit(repo), detectStore = detectTicketStore } = {}) {
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
    try {
      git('add', '--', storePath, MANIFEST_FILE);
      git('commit', '-q', '-m', `chore(${ticketId}): mark completed after passing merge gate`, '--', storePath, MANIFEST_FILE);
    } catch (error) {
      // A failed commit (e.g. a rejecting hook) must NOT leave the shared integration
      // checkout dirty. Restore the two owned paths to their exact pre-completion
      // bytes and unstage them, then re-throw so the caller degrades to "merged, not
      // yet completed". Safe under the held lock — no other writer can have touched
      // these paths since we captured them.
      // The shard is covered by the ticket lock we hold, so restoring it is safe.
      restoreFile(storeAbs, priorStore);
      // The manifest is NOT: its appends are serialized by the ledger lock, and other
      // pipeline steps record gate evidence concurrently. Only roll it back when it is
      // byte-identical to what THIS completion left — i.e. nothing appended since.
      // Otherwise leave it: an extra append-only evidence line is harmless, erasing a
      // concurrent writer's evidence is data loss.
      const manifestNow = existsSync(manifestAbs) ? readFileSync(manifestAbs) : null;
      const untouchedSinceOurAppend = manifestNow !== null && afterManifest !== null
        && manifestNow.equals(afterManifest);
      if (untouchedSinceOurAppend) restoreFile(manifestAbs, priorManifest);
      try { git('reset', '-q', '--', storePath, MANIFEST_FILE); } catch { /* best-effort unstage */ }
      throw error;
    }

    return { completed: true, preCompletionSha, shardPath: storePath };
  } finally {
    releaseTicketLock(lock);
  }
}
