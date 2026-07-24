// The run orchestrator (spec §6, §9) — wires the scheduler state machine to the
// worktree/merge choreography. It writes ONLY the per-run integration branch
// `fleet/run-<runId>`; base is never touched (§9). All world-effects are injected
// via `deps`, so the merge choreography is unit-testable (AC13) with fake git.

import { newStatus, withTicket, statusById, inFlightIds, saveStatus } from './status.mjs';
import { planRound, advanceTicket } from './scheduler.mjs';
import { createMutex } from './mutex.mjs';

export function integrationBranchName(runId) {
  return `fleet/run-${runId}`;
}

/**
 * Effects for one ticket's pipeline, closing over its worktree + startSha so the
 * scope/prosecution gates diff against `startSha` (the integration tip it was cut
 * from), never base (adversarial-review N3). Builds/gates/prosecution run
 * concurrently across tickets; the MERGE runs under `mergeMutex` so merges are
 * strictly sequential (spec §9; adversarial-review C4).
 */
function buildEffects(ticket, wt, deps, integrationBranch, mergeMutex, runState, markContaminated = () => {}) {
  return {
    dispatch: ({ strike, deadEnds }) => deps.dispatch({ ticket, worktree: wt.path, startSha: wt.startSha, strike, deadEnds }),
    gate: () => deps.gate({ ticket, worktree: wt.path, startSha: wt.startSha }),
    prosecute: () => deps.prosecute({ ticket, worktree: wt.path, startSha: wt.startSha }),
    flail: () => deps.flail({ ticket, worktree: wt.path }),
    // Best-effort evidence (spec §8.5): a recorder error must never abort the run.
    record: (phase, ok) => { try { deps.recordGate?.({ ticket, phase, ok }); } catch { /* evidence is best-effort */ } },
    merge: () => mergeMutex.runExclusive(async () => {
      // QUARANTINE: once a gate-rejected completion could not be withdrawn, the shared
      // integration branch carries an ungated commit. Nothing further may land on it —
      // no merges, no retries — and the run must not open a PR from it.
      if (runState?.contaminated) {
        return { ok: false, output: `integration branch quarantined: ${runState.contaminationReason}` };
      }
      const { mergeSha, preMergeSha } = await deps.mergeToIntegration({ ticket, branch: wt.branch, integrationBranch, worktree: wt.path });
      const post = await deps.postMergeGate({ ticket, integrationBranch });
      if (!post.ok) {
        const rev = await deps.revertMerge({ integrationBranch, mergeSha, preMergeSha });
        // revertMerge returns { ok: false, method: 'refused' } when it cannot safely
        // undo the merge (HEAD moved and `git revert` also failed). That leaves the
        // GATE-REJECTED merge on the shared branch — the same hazard a failed completion
        // withdrawal creates, and it must get the same treatment: quarantine, so no
        // further merge lands and no PR opens from the contaminated branch. Reporting
        // `reverted: true` here (ignoring rev.ok) let that merge ride into the PR.
        if (!rev.ok) {
          // revertMerge returns ok:false both when it could not withdraw the merge AND
          // when it withdrew ours but an UNGATED intervening commit remains. Its reason
          // is accurate for either; surface it verbatim rather than assuming which.
          const reason = rev.reason ?? `post-merge gate failed and the merge could not be safely withdrawn (${rev.method}) on ${integrationBranch}`;
          markContaminated(reason);
          return { ok: false, output: `${reason}; integration branch quarantined` };
        }
        return { ok: false, reverted: true, output: `post-merge gate failed; recovery=${rev.method}` };
      }
      // Post-merge gate PASSED (T73): mark the ticket completed on the integration
      // branch so the single PR the fleet opens carries the add-only completed:true
      // annotation. Runs here — inside the merge mutex, right after the gate that
      // just checked the integration branch out — so exactly one completion touches
      // that branch at a time. Best-effort: the merge already landed and passed its
      // gate, so a completion failure must NOT revert good, shipped work; it degrades
      // to the pre-T73 status quo (merged, not yet marked completed) and is logged.
      try {
        const completion = await deps.completeTicket?.({ ticket, integrationBranch });
        // The completion adds a commit AFTER the gate that just passed, so re-run the
        // gate over it — no unvalidated commit reaches the PR. If that re-gate fails,
        // withdraw ONLY the completion commit (the shipped merge below it stays) and
        // degrade to the pre-T73 status quo: merged, not marked completed.
        if (completion?.completed && completion.preCompletionSha) {
          const recheck = await deps.postMergeGate({ ticket, integrationBranch });
          if (!recheck.ok) {
            // The completion commit FAILED the gate, so it must come off the branch.
            // Withdrawal failing is NOT a degradation we may swallow: the branch would
            // carry a gate-rejected commit into the fleet PR. Both a missing withdrawal
            // path and a throwing one fail the ticket loudly instead.
            if (!deps.revertCompletion) {
              const reason = 'a gate-rejected completion commit could not be withdrawn (no withdrawal path wired)';
              markContaminated(reason);
              return { ok: false, output: `${reason}; integration branch quarantined` };
            }
            try {
              await deps.revertCompletion({ ticket, integrationBranch, toSha: completion.preCompletionSha, shardPath: completion.shardPath, completionSha: completion.completionSha });
            } catch (revertError) {
              const reason = `a gate-rejected completion commit could not be withdrawn (${revertError.message})`;
              markContaminated(reason);
              return { ok: false, output: `${reason}; integration branch quarantined` };
            }
            deps.log?.(`${ticket.id} WARNING: gate over the completion commit failed; completion withdrawn (merged, not marked completed)`);
          }
        }
      } catch (error) {
        // A completion that failed but left its evidence append behind is NOT a
        // degradation we can shrug off: the ledger now attests a completion that never
        // landed, and a later completion's `git add` would commit it. Quarantine.
        if (error?.ledgerDirty || error?.branchContaminated) {
          const reason = error.branchContaminated
            ? `the checkout switched during the completion commit — an UNGATED completion commit may be on ${integrationBranch} (${error.message})`
            : `completion evidence could not be withdrawn after a failed commit (${error.message})`;
          markContaminated(reason);
          return { ok: false, output: `${reason}; integration branch quarantined` };
        }
        deps.log?.(`${ticket.id} WARNING: post-merge completion failed (${error.message}); ticket merged but not marked completed`);
      }
      return { ok: true };
    }),
  };
}

/**
 * Drive a full fleet run. Returns a summary; persists status after every
 * transition when `deps.statusDir` is given.
 *
 * @param all     the ticket array (already completed-filtered upstream is fine;
 *                planRound also filters completed:true)
 * @param runId   deterministic run id (caller supplies — no Date/random here)
 * @param config  effective run config (base, concurrency, onlyIds, …)
 * @param deps    injected effects (createWorktree, dispatch, gate, prosecute,
 *                flail, mergeToIntegration, postMergeGate, revertMerge, cleanup,
 *                openPR?, log?, statusDir?)
 */
export async function runFleet({ all, runId, config, deps, resume }) {
  const log = deps.log ?? (() => {});
  // Run-scoped quarantine flag. Set when a gate-rejected completion commit could not
  // be withdrawn: the shared integration branch then carries an ungated commit, so no
  // further merge may land on it and the run must never open a PR from it.
  const runState = { contaminated: false, contaminationReason: null };
  // Resume (adversarial-review L3): reuse the recorded run — its integration
  // branch, runId, and reconciled status — instead of starting fresh, so merged
  // tickets are not re-dispatched and the prior integration branch is continued.
  const resuming = !!(resume && resume.status && resume.integrationBranch);
  const integrationBranch = resuming ? resume.integrationBranch : integrationBranchName(runId);
  if (!resuming) {
    await deps.createIntegrationBranch?.({ integrationBranch, baseSha: config.baseSha });
  } else {
    // Resume: the branch survives in the repo, but its dedicated worktree may not —
    // cleanup, a crash, or manual tidying can remove it, and EVERY integration step now
    // requires it. Re-attach before dispatching anything, so a recoverable run fails
    // fast here instead of after burning worker time on tickets that cannot merge.
    await deps.ensureIntegrationWorktree?.({ integrationBranch });
  }

  let status = resuming ? resume.status : newStatus({
    runId,
    base: config.base,
    baseSha: config.baseSha,
    integrationBranch,
    concurrency: config.concurrency,
    sandboxMode: config.sandboxMode,
    startedAt: config.startedAt,
  });
  const persist = () => { if (deps.statusDir) saveStatus(deps.statusDir, status); };

  // Quarantine is a property of the BRANCH, not of this process, so it is restored
  // from the persisted status on resume — otherwise a resume would start "clean" and
  // happily open a PR from a branch still carrying a gate-rejected commit.
  runState.contaminated = Boolean(status.contaminated);
  runState.contaminationReason = status.contaminationReason ?? null;
  const markContaminated = (reason) => {
    runState.contaminated = true;
    runState.contaminationReason = reason;
    status = { ...status, contaminated: true, contaminationReason: reason };
    persist(); // persist IMMEDIATELY — a crash after this must not forget the quarantine
  };

  // Fail closed before doing any work: a quarantined branch cannot accept merges, so
  // dispatching would only burn agents on work that can never land.
  if (runState.contaminated) {
    log(`FLEET QUARANTINE: ${integrationBranch} is quarantined (${runState.contaminationReason}); refusing to resume. Clean the branch, then start a new run.`);
    const quarantinedResults = Object.fromEntries(Object.entries(status.tickets).map(([id, r]) => [id, r.state]));
    return {
      integrationBranch,
      results: quarantinedResults,
      merged: Object.values(quarantinedResults).filter((s) => s === 'merged').length,
      prCount: 0,
      status,
      contaminated: true,
      contaminationReason: runState.contaminationReason,
    };
  }

  const cap = config.concurrency;
  const onlyIds = config.onlyIds;
  const mergeMutex = createMutex();

  // Mark subset-blocked tickets up front so they are reported, not looped on.
  const first = planRound(all, { statusById: statusById(status), inFlightIds: inFlightIds(status), cap, onlyIds });
  for (const id of first.blocked) status = withTicket(status, id, { state: 'blocked', reason: 'predecessor excluded from subset' });
  persist();

  // Event-driven concurrent pool (spec §6, §9; adversarial-review C4): admit up
  // to the free-slot budget of non-overlapping tickets, run their build→gate→
  // prosecute pipelines CONCURRENTLY, and re-plan whenever any ticket finishes.
  // Only the merge phase is serialized (via mergeMutex inside buildEffects).
  const inFlight = new Map(); // id → Promise

  const startTicket = async (ticket) => {
    const wt = await deps.createWorktree({ ticket, integrationBranch });
    status = withTicket(status, ticket.id, { state: 'building', branch: wt.branch, startSha: wt.startSha, strikes: 0 });
    persist();
    await deps.provision?.({ ticket, worktree: wt.path });
    const outcome = await advanceTicket(ticket, buildEffects(ticket, wt, deps, integrationBranch, mergeMutex, runState, markContaminated), { log });
    status = withTicket(status, ticket.id, { state: outcome.state, strikes: outcome.strikes, reason: outcome.reason, prosecution: outcome.prosecution ?? null });
    persist();
    await deps.cleanup?.({ ticket, worktree: wt.path, state: outcome.state });
    log(`${ticket.id} → ${outcome.state}${outcome.reason ? ` (${outcome.reason})` : ''}`);
  };

  for (;;) {
    const { admit } = planRound(all, {
      statusById: statusById(status),
      inFlightIds: [...inFlight.keys()],
      cap,
      onlyIds,
    });
    for (const ticket of admit) {
      // Reserve the slot synchronously (mark building) BEFORE awaiting, so the
      // next planRound in this same tick sees it in flight and respects the cap
      // and scope-overlap serialization.
      status = withTicket(status, ticket.id, { state: 'building', strikes: 0 });
      const p = startTicket(ticket).finally(() => inFlight.delete(ticket.id));
      inFlight.set(ticket.id, p);
    }
    if (inFlight.size === 0) break;
    // Wait for at least one in-flight ticket to finish, then re-plan.
    await Promise.race(inFlight.values());
  }

  const results = Object.fromEntries(Object.entries(status.tickets).map(([id, r]) => [id, r.state]));
  const merged = Object.values(results).filter((s) => s === 'merged').length;

  // Run end: open exactly ONE PR from the integration branch to base (§9), only
  // if something merged and the deps provide it. The fleet never pushes base.
  let prCount = 0;
  // Set ONLY when a PR was attempted (merged, not quarantined, opener wired) and openPR
  // REPORTED it did not open. It drives a non-zero exit so automation never treats a run
  // whose merged work was never published as complete (adversarial-review round-33). It is
  // deliberately NOT set when no opener is wired — that is a missing attempt, not a failure.
  let prOpenFailed = false;
  // A quarantined branch is NEVER opened as a PR, however many other tickets merged
  // cleanly — the branch itself carries a commit that failed its gate.
  if (runState.contaminated) {
    log(`FLEET QUARANTINE: ${integrationBranch} not opened as a PR — ${runState.contaminationReason}. Inspect and clean the branch manually.`);
  } else if (merged > 0 && deps.openPR) {
    // Trust openPR's REPORTED outcome — never fabricate success. It returns
    // { opened:false, reason } when gh is unavailable or the push / PR creation fails,
    // and counting that as an opened PR would tell the operator a PR exists when none
    // does (adversarial-review round-31). await it: the real openPR runs `gh pr create`
    // asynchronously, so an un-awaited call could miss a creation failure entirely.
    const pr = await deps.openPR({ integrationBranch, base: config.base });
    if (pr && pr.opened) {
      prCount = 1;
    } else {
      prOpenFailed = true;
      log(`FLEET: ${integrationBranch} merged ${merged} ticket(s) but the PR was NOT opened${pr?.reason ? ` — ${pr.reason}` : ''}. Push the branch and open the PR manually.`);
    }
  }

  return { integrationBranch, results, merged, prCount, prOpenFailed, status, contaminated: runState.contaminated, contaminationReason: runState.contaminationReason };
}

/**
 * Derive the process exit code from a fleet run summary.
 *
 * A QUARANTINED run is a failure no matter what the per-ticket states say. Quarantine
 * is persisted the instant it occurs, but a crash between that write and a ticket's own
 * state update can leave the ticket nonterminal ('merging'); a resume then fails closed
 * without touching it. Keying the exit code on failed/blocked states alone would report
 * 0 for that quarantined-no-work run — so `contaminated` is checked first.
 *
 * A PR-open failure is ALSO a non-zero exit: if every ticket merged but the PR could not be
 * opened (gh unavailable, push or `gh pr create` failed), the merged work was never
 * published. Exiting 0 there would let CI or an operator script mark the fleet operation
 * complete when nothing is on a PR (adversarial-review round-33).
 *
 * @returns {0|2} 2 = quarantined, some ticket failed/blocked, OR the PR failed to open;
 *   0 = clean.
 */
/** Count the tickets in a terminal non-success state. Shared by the exit code AND the CLI's
 *  end-of-run summary line so the two can never disagree on what "failed/blocked" means. */
export function failedBlockedCount(results) {
  return Object.values(results ?? {}).filter((s) => s === 'failed' || s === 'blocked').length;
}

export function runExitCode(summary) {
  if (summary?.contaminated) return 2;
  if (summary?.prOpenFailed) return 2;
  return failedBlockedCount(summary?.results) > 0 ? 2 : 0;
}
