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

import { ACTIVE_DIRECTORY, DirectoryTicketStore, LEGACY_FILE, detectTicketStore, TicketService, ticketFilename } from '@adlc/tickets';
import { defaultGit } from './worktrees.mjs';

const MANIFEST_FILE = '.adlc/manifest.jsonl';

/** Repo-relative path of the store artifact a completion of `id` rewrites. */
function completionStorePath(store, id) {
  return store instanceof DirectoryTicketStore ? `${ACTIVE_DIRECTORY}/${ticketFilename(id)}` : LEGACY_FILE;
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
  const store = detectStore({ root: repo });
  const snapshot = store.load();
  const existing = snapshot.get(ticketId);
  if (!existing) return { completed: false, reason: 'ticket-not-found' };
  // Idempotency: guard BEFORE planComplete. A no-change complete transaction
  // still records evidence (evidenceRequired) and would leave an empty commit —
  // so an already-completed ticket must short-circuit here.
  if (existing.completed === true) return { completed: false, alreadyComplete: true };

  const service = new TicketService(store, { root: repo });
  service.apply(service.planComplete(ticketId));

  // Commit ONLY the completion artifacts (the shard/legacy file + the evidence
  // ledger). A path-scoped add + commit never sweeps in unrelated build output
  // the post-merge gate may have left in the working tree.
  const storePath = completionStorePath(store, ticketId);
  git('add', '--', storePath, MANIFEST_FILE);
  git('commit', '-q', '-m', `chore(${ticketId}): mark completed after passing merge gate`, '--', storePath, MANIFEST_FILE);

  return { completed: true };
}
