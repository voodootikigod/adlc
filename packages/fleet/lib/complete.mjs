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
import { ACTIVE_DIRECTORY, DirectoryTicketStore, LEGACY_FILE, detectTicketStore, TicketService, ticketFilename } from '@adlc/tickets';
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
  const snapshot = store.load();
  const existing = snapshot.get(ticketId);
  if (!existing) return { completed: false, reason: 'ticket-not-found' };
  // Idempotency: guard BEFORE planComplete. A no-change complete transaction
  // still records evidence (evidenceRequired) and would leave an empty commit —
  // so an already-completed ticket must short-circuit here.
  if (existing.completed === true) return { completed: false, alreadyComplete: true };

  // Capture the exact pre-completion bytes of the two paths this touches, BEFORE
  // the transaction writes them, so a failed commit can be rolled back precisely
  // whether or not the manifest already existed.
  const storePath = completionStorePath(store, ticketId);
  const storeAbs = join(repo, storePath);
  const manifestAbs = join(repo, MANIFEST_FILE);
  const priorStore = existsSync(storeAbs) ? readFileSync(storeAbs) : null;
  const priorManifest = existsSync(manifestAbs) ? readFileSync(manifestAbs) : null;

  // rails-guard-ci DENIES a PR that CREATES .adlc/manifest.jsonl with evidence
  // (only a verified migration may); appending to an existing one is allowed. On a
  // repo whose ADLC manifest is not yet bootstrapped, recording completion evidence
  // here would create the ledger and get the whole fleet PR rejected. Skip
  // auto-completion in that case and degrade to "merged, not yet completed" rather
  // than open a PR the CI gate is guaranteed to reject.
  if (priorManifest === null) return { completed: false, reason: 'no-manifest-baseline' };

  const service = new TicketService(store, { root: repo });
  service.apply(service.planComplete(ticketId));

  // Commit ONLY the completion artifacts (the shard/legacy file + the evidence
  // ledger). A path-scoped add + commit never sweeps in unrelated build output
  // the post-merge gate may have left in the working tree.
  try {
    git('add', '--', storePath, MANIFEST_FILE);
    git('commit', '-q', '-m', `chore(${ticketId}): mark completed after passing merge gate`, '--', storePath, MANIFEST_FILE);
  } catch (error) {
    // planComplete already wrote the shard + manifest to disk and `git add` may
    // have staged them. A failed commit (e.g. a rejecting commit hook) must NOT
    // leave the shared integration checkout dirty — a later fleet step could sweep
    // the orphaned staged change into an unrelated commit, and the pushed branch
    // would be inconsistent. Restore the two owned paths to their exact
    // pre-completion bytes, unstage them, then re-throw so the caller degrades to
    // "merged, not yet completed" exactly as before.
    restoreFile(storeAbs, priorStore);
    restoreFile(manifestAbs, priorManifest);
    try { git('reset', '-q', '--', storePath, MANIFEST_FILE); } catch { /* best-effort unstage */ }
    throw error;
  }

  return { completed: true };
}
