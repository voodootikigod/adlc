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
 *
 * `wt.gatePath` (fleet-ext item 12): in mirror mode the worker builds in a
 * worktree of the caller-supplied bare mirror, and the gates, prosecution and
 * merge run in a caller-repository worktree at the fetched-back branch. In shared
 * mode both are the same path, so every existing caller is unchanged.
 */
function buildEffects(ticket, wt, deps, integrationBranch, mergeMutex, runState, markContaminated = () => {}, config = {}) {
  const gatePath = wt.gatePath ?? wt.path;
  return {
    preStrike: deps.preStrike ? ({ strike }) => deps.preStrike({ ticket, strike }) : undefined,
    dispatch: ({ strike, deadEnds }) => deps.dispatch({ ticket, worktree: wt.path, startSha: wt.startSha, strike, deadEnds, gateWorktree: gatePath, branch: wt.branch }),
    // `remainingMs` (fleet-ext item 5): the run's remaining wall clock, forwarded so
    // every awaited phase is bounded by the advertised deadline, not just dispatch.
    gate: ({ remainingMs = null } = {}) => deps.gate({ ticket, worktree: gatePath, startSha: wt.startSha, remainingMs }),
    prosecute: ({ remainingMs = null } = {}) => deps.prosecute({ ticket, worktree: gatePath, startSha: wt.startSha, remainingMs }),
    flail: () => deps.flail({ ticket, worktree: gatePath }),
    // Best-effort evidence (spec §8.5): a recorder error must never abort the run.
    record: (phase, ok, data) => { try { deps.recordGate?.({ ticket, phase, ok, data }); } catch { /* evidence is best-effort */ } },
    // §8a: one usage carrier per DISPATCH, independent of any later verdict.
    // `strike` identifies WHICH rung of the F8 ladder that dispatch ran on (#401),
    // so the carrier can name the channel that actually spent the tokens.
    recordDispatchUsage: (result, strike) => { try { deps.recordDispatchUsage?.({ ticket, result, strike }); } catch { /* evidence is best-effort */ } },
    merge: ({ remainingMs = null } = {}) => mergeMutex.runExclusive(async () => {
      // The deadline is re-checked INSIDE the mutex: a merge queued behind another
      // ticket's merge must not land past the wall clock on a stale budget (codex r4).
      if (config.deadline != null) {
        const nowMs = (deps.now ?? Date.now)();
        if (nowMs >= config.deadline) return { ok: false, expired: true, output: 'external wall clock expired before the merge' };
        remainingMs = Math.max(1, config.deadline - nowMs);
      }
      // QUARANTINE: once a gate-rejected completion could not be withdrawn, the shared
      // integration branch carries an ungated commit. Nothing further may land on it —
      // no merges, no retries — and the run must not open a PR from it.
      if (runState?.contaminated) {
        return { ok: false, output: `integration branch quarantined: ${runState.contaminationReason}` };
      }
      const { mergeSha, preMergeSha } = await deps.mergeToIntegration({ ticket, branch: wt.branch, integrationBranch, worktree: gatePath });
      let post;
      try { post = await deps.postMergeGate({ ticket, integrationBranch, remainingMs }); }
      catch (e) {
        // A post-merge gate that THREW is a gate with no verdict: the merge is withdrawn exactly as
        // for a red gate; if it cannot be withdrawn the branch is quarantined (codex r21 #1).
        const rev = await deps.revertMerge({ integrationBranch, mergeSha, preMergeSha });
        if (!rev.ok) { const reason = rev.reason ?? `post-merge gate threw (${e.message}) and the merge could not be safely withdrawn (${rev.method}) on ${integrationBranch}`; markContaminated(reason); return { ok: false, output: `${reason}; integration branch quarantined` }; }
        return { ok: false, reverted: true, output: `post-merge gate threw: ${e.message}; recovery=${rev.method}` };
      }
      if (!post.ok) {
        const rev = await deps.revertMerge({ integrationBranch, mergeSha, preMergeSha });
        // A post-merge gate cut short by the wall clock: the merge is withdrawn and the
        // ticket PAUSES (resumable), never a strike (codex r5).
        if (rev.ok && post.timedOut && config.deadline != null && (deps.now ?? Date.now)() >= config.deadline) return { ok: false, expired: true, output: 'external wall clock expired during the post-merge gate; merge withdrawn' };
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
      // fleet-ext item 2: `--no-complete` hands ticket completion to the caller.
      // The merge landed and passed its gate; nothing else happens on the branch.
      if (config.noComplete === true) return { ok: true };
      // The completion is a further commit: it must not start past the deadline, and
      // its re-gate gets a FRESH remaining budget (codex r6). Past expiry the merge
      // stands (it landed within budget) and the ticket is merged-not-completed.
      if (config.deadline != null) {
        const nowMs = (deps.now ?? Date.now)();
        if (nowMs >= config.deadline) return { ok: true, completed: false, output: 'external wall clock expired before completion; merged, not marked completed' };
        remainingMs = Math.max(1, config.deadline - nowMs);
      }
      // Post-merge gate PASSED (T73): mark the ticket completed on the integration
      // branch so the single PR the fleet opens carries the add-only completed:true
      // annotation. Runs here — inside the merge mutex, right after the gate that
      // just checked the integration branch out — so exactly one completion touches
      // that branch at a time. Best-effort: the merge already landed and passed its
      // gate, so a completion failure must NOT revert good, shipped work; it degrades
      // to the pre-T73 status quo (merged, not yet marked completed) and is logged.
      const pastDeadline = () => config.deadline != null && (deps.now ?? Date.now)() >= config.deadline;
      // Withdraw ONLY the completion commit (the shipped merge below it stays). Withdrawal
      // failing is NOT a degradation we may swallow: the branch would carry an unvalidated
      // or past-deadline commit into the fleet PR. Both a missing withdrawal path and a
      // throwing one quarantine the branch instead. Returns the quarantine result, or null.
      const withdrawCompletion = (completion, why) => {
        if (!deps.revertCompletion) {
          const reason = `${why} could not be withdrawn (no withdrawal path wired)`;
          markContaminated(reason);
          return Promise.resolve({ ok: false, output: `${reason}; integration branch quarantined` });
        }
        return Promise.resolve()
          .then(() => deps.revertCompletion({ ticket, integrationBranch, toSha: completion.preCompletionSha, shardPath: completion.shardPath, completionSha: completion.completionSha, ledgerPath: completion.ledgerPath, raced: completion.raced }))
          .then(() => null, (revertError) => {
            const reason = `${why} could not be withdrawn (${revertError.message})`;
            markContaminated(reason);
            return { ok: false, output: `${reason}; integration branch quarantined` };
          });
      };
      try {
        const completion = await deps.completeTicket?.({ ticket, integrationBranch });
        if (completion?.completed && completion.preCompletionSha) {
          // The completion commit is bounded by the wall clock like everything else: one
          // that landed past the deadline comes off the branch, and the run reports
          // wall-clock so no PR is published by this invocation (codex r23 #4).
          if (pastDeadline()) {
            const quarantined = await withdrawCompletion(completion, 'a completion commit that landed past the wall clock');
            if (quarantined) return quarantined;
            deps.log?.(`${ticket.id} WARNING: wall clock expired during the completion commit; completion withdrawn (merged, not marked completed)`);
            return { ok: true, completed: false, expiredAfterMerge: true, output: 'external wall clock expired during completion; completion withdrawn (merged, not marked completed)' };
          }
          // The completion adds a commit AFTER the gate that just passed, so re-run the
          // gate over it — no unvalidated commit reaches the PR. If that re-gate fails,
          // withdraw the completion and degrade to the pre-T73 status quo: merged, not
          // marked completed.
          const fresh = config.deadline != null ? Math.max(1, config.deadline - (deps.now ?? Date.now)()) : remainingMs;
          // A re-gate that THROWS is a gate with no verdict — handled exactly like a red one
          // (withdraw the completion; a failed withdrawal quarantines), never left to the outer
          // catch, which would return success with the commit still on the branch (codex r24 #2).
          let recheck;
          try { recheck = await deps.postMergeGate({ ticket, integrationBranch, remainingMs: fresh }); }
          catch (gateError) { recheck = { ok: false, threw: true, output: `post-completion gate threw: ${gateError?.message ?? gateError}` }; }
          if (!recheck.ok) {
            const quarantined = await withdrawCompletion(completion, 'a gate-rejected completion commit');
            if (quarantined) return quarantined;
            deps.log?.(`${ticket.id} WARNING: gate over the completion commit failed; completion withdrawn (merged, not marked completed)`);
            if (pastDeadline()) return { ok: true, completed: false, expiredAfterMerge: true, output: 'external wall clock expired during the completion re-gate; completion withdrawn (merged, not marked completed)' };
            return { ok: true, completed: false, output: 'completion withdrawn after a red re-gate (merged, not marked completed)' };
          } else if (pastDeadline()) {
            // Landed and gated within budget; only the return crossed the deadline.
            return { ok: true, completed: true, expiredAfterMerge: true, output: 'external wall clock expired after completion; merged and completed, not published by this invocation' };
          }
          return { ok: true, completed: true };
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
 * @param config  effective run config (base, concurrency, onlyIds, maxStrikes,
 *                deadline (epoch ms, fleet-ext item 5), initialDeadEnds (fenced
 *                strings, item 3), noPr (item 1), noComplete (item 2), …)
 * @param deps    injected effects (createWorktree, dispatch, gate, prosecute,
 *                flail, mergeToIntegration, postMergeGate, revertMerge, cleanup,
 *                preStrike?, openPR?, log?, statusDir?, now?)
 */
export async function runFleet({ all, runId, config, deps, resume }) {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
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
      strikesConsumed: 0,
      wallClockExpired: false,
    };
  }

  const cap = config.concurrency;
  const onlyIds = config.onlyIds;
  const maxStrikes = config.maxStrikes ?? 2;
  const deadline = config.deadline ?? null;
  const initialDeadEnds = config.initialDeadEnds ?? [];
  const mergeMutex = createMutex();
  let strikesConsumed = 0;
  let wallClockExpired = false;
  let dispatchRefused = false; // a sandbox policy mismatch: run-level operational refusal (codex r7)
  let pipelineError = false; // a thrown ticket effect: run-level operational failure (codex r10)
  const expired = () => deadline != null && now() >= deadline;

  // Mark subset-blocked tickets up front so they are reported, not looped on.
  const first = planRound(all, { statusById: statusById(status), inFlightIds: inFlightIds(status), cap, onlyIds });
  for (const id of first.blocked) status = withTicket(status, id, { state: 'blocked', reason: 'predecessor excluded from subset', reasonCode: 'ticket-blocked' });
  persist();

  // Event-driven concurrent pool (spec §6, §9; adversarial-review C4): admit up
  // to the free-slot budget of non-overlapping tickets, run their build→gate→
  // prosecute pipelines CONCURRENTLY, and re-plan whenever any ticket finishes.
  // Only the merge phase is serialized (via mergeMutex inside buildEffects).
  const inFlight = new Map(); // id → Promise
  // Tickets whose setup was refused in THIS run: left pending on disk for the next
  // invocation, never re-admitted by this run's planner (codex r12).
  const refusedThisRun = new Set();

  const startTicket = async (ticket) => {
    // A resumed ticket continues from the strike count its reconciled status
    // carries (fleet-ext item 7 / AC4) — a resume is the SAME run, not a fresh one.
    const startStrikes = status.tickets[ticket.id]?.strikes ?? 0;
    let wt;
    try {
      wt = await deps.createWorktree({ ticket, integrationBranch });
    } catch (e) {
      // A setup failure is THIS ticket's outcome (codex r4): recorded, logged, and
      // the run keeps awaiting the other in-flight tickets instead of unwinding
      // around them with the lock released.
      // Left PENDING, not failed: a transient setup failure must be re-attempted by the
      // next identical invocation once its cause is fixed (codex r12); the run still
      // reports dispatch-refused (exit 1) so nobody mistakes it for a clean finish.
      status = withTicket(status, ticket.id, { state: 'pending', strikes: startStrikes, reason: `worktree setup failed: ${e.message}`, reasonCode: null });
      refusedThisRun.add(ticket.id);
      dispatchRefused = true;
      persist();
      log(`${ticket.id} → failed (worktree setup failed: ${e.message})`);
      return;
    }
    // A cleanup failure is recorded on the ticket and logged, never thrown (codex r16 #1): a thrown
    // cleanup would abort the whole run while sibling tickets are in flight and release the lock.
    const safeCleanup = async (args) => {
      try { await deps.cleanup?.(args); }
      catch (e) {
        status = withTicket(status, ticket.id, { cleanupFailed: `${e.message}`.slice(0, 200) });
        persist();
        log(`${ticket.id} → cleanup failed (${e.message}); the run continues`);
      }
    };
    status = withTicket(status, ticket.id, { state: 'building', branch: wt.branch, startSha: wt.startSha, strikes: startStrikes });
    persist();
    try { await deps.provision?.({ ticket, worktree: wt.path }); }
    catch (e) {
      status = withTicket(status, ticket.id, { state: 'pending', strikes: startStrikes, reason: `provisioning failed: ${e.message}`, reasonCode: null });
      refusedThisRun.add(ticket.id);
      dispatchRefused = true;
      persist();
      log(`${ticket.id} → failed (provisioning failed: ${e.message})`);
      await safeCleanup({ ticket, worktree: wt.path, state: 'failed' });
      return;
    }
    let outcome;
    // The strike the scheduler ENTERED is observed at dispatch, so a thrown effect
    // keeps its consumed strike (codex r10) and is reported as pipeline-error.
    const entered = { strike: startStrikes };
    const effects = buildEffects(ticket, wt, deps, integrationBranch, mergeMutex, runState, markContaminated, config);
    const dispatchEffect = effects.dispatch;
    effects.dispatch = (a) => { entered.strike = a.strike; return dispatchEffect(a); };
    try {
      outcome = await advanceTicket(ticket, effects, { log, maxStrikes, startStrikes, initialDeadEnds, deadline, now });
    } catch (e) {
      // A thrown effect is THIS ticket's failure (codex r8): recorded and logged; the
      // run keeps awaiting its siblings and releases the lock only when all are done.
      outcome = { state: 'failed', strikes: entered.strike, reason: `pipeline error: ${e?.message ?? e}`, reasonCode: null, pipelineError: true };
      log(`${ticket.id} pipeline threw: ${e?.stack ?? e?.message ?? e}`);
    }
    strikesConsumed += Math.max(0, (outcome.strikes ?? startStrikes) - startStrikes);
    if (outcome.reasonCode === 'wall-clock') wallClockExpired = true;
    if (outcome.policyMismatch) dispatchRefused = true;
    if (outcome.pipelineError) pipelineError = true;
    status = withTicket(status, ticket.id, {
      state: outcome.state, strikes: outcome.strikes, reason: outcome.reason, reasonCode: outcome.reasonCode ?? null,
      prosecution: outcome.prosecution ?? null, review: outcome.review ?? null,
    });
    persist();
    await safeCleanup({ ticket, worktree: wt.path, state: outcome.state });
    log(`${ticket.id} → ${outcome.state}${outcome.reason ? ` (${outcome.reason})` : ''}`);
  };

  for (;;) {
    // fleet-ext item 5: once the external wall clock has expired, nothing new is
    // dispatched. Pending tickets stay pending — the run is left resumable.
    if (expired()) { wallClockExpired = true; if (inFlight.size === 0) break; }
    const { admit } = expired() ? { admit: [] } : planRound(all.filter((t) => !refusedThisRun.has(t.id)), {
      statusById: statusById(status),
      inFlightIds: [...inFlight.keys()],
      cap,
      onlyIds,
    });
    for (const ticket of admit) {
      // Reserve the slot synchronously (mark building) BEFORE awaiting, so the
      // next planRound in this same tick sees it in flight and respects the cap
      // and scope-overlap serialization. Keep the reconciled strike count.
      status = withTicket(status, ticket.id, { state: 'building', strikes: status.tickets[ticket.id]?.strikes ?? 0 });
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
  } else if (wallClockExpired) {
    // fleet-ext item 5: no PR action past the wall clock either; the resumed run publishes.
    log(`FLEET: wall clock expired — ${integrationBranch} is not opened as a PR by this invocation (resume to continue).`);
  } else if (config.noPr === true) {
    // fleet-ext item 1: the caller owns the integration branch from here.
    if (merged > 0) log(`FLEET: --no-pr — ${integrationBranch} left for the caller (${merged} merged).`);
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

  return {
    integrationBranch, results, merged, prCount, prOpenFailed, dispatchRefused, pipelineError, status,
    contaminated: runState.contaminated, contaminationReason: runState.contaminationReason,
    strikesConsumed, wallClockExpired,
  };
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
 * A PAUSED ticket (quota / wall clock, fleet-ext) is exit 2 as well: the work did not
 * land, and the caller resumes by re-invoking. The `reason` in the --json document tells
 * the two apart.
 *
 * @returns {0|2} 2 = quarantined, some ticket failed/blocked/paused, the wall clock
 *   expired with work pending, OR the PR failed to open; 0 = clean.
 */
/** Count the tickets in a terminal non-success state. Shared by the exit code AND the CLI's
 *  end-of-run summary line so the two can never disagree on what "failed/blocked" means. */
export function failedBlockedCount(results) {
  return Object.values(results ?? {}).filter((s) => s === 'failed' || s === 'blocked').length;
}

/** Count the tickets left resumable by a quota pause or the external wall clock. */
export function pausedCount(results) {
  return Object.values(results ?? {}).filter((s) => s === 'paused').length;
}

export function runExitCode(summary) {
  if (summary?.contaminated) return 2;
  if (summary?.prOpenFailed) return 2;
  if (summary?.dispatchRefused) return 1; // operational: the sandbox could not be built as configured
  if (summary?.pipelineError) return 1; // operational: an effect threw
  if (summary?.wallClockExpired) return 2;
  if (pausedCount(summary?.results) > 0) return 2;
  return failedBlockedCount(summary?.results) > 0 ? 2 : 0;
}
