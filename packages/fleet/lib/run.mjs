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
function buildEffects(ticket, wt, deps, integrationBranch, mergeMutex) {
  return {
    dispatch: ({ strike, deadEnds }) => deps.dispatch({ ticket, worktree: wt.path, startSha: wt.startSha, strike, deadEnds }),
    gate: () => deps.gate({ ticket, worktree: wt.path, startSha: wt.startSha }),
    prosecute: () => deps.prosecute({ ticket, worktree: wt.path, startSha: wt.startSha }),
    flail: () => deps.flail({ ticket, worktree: wt.path }),
    // Best-effort evidence (spec §8.5): a recorder error must never abort the run.
    record: (phase, ok) => { try { deps.recordGate?.({ ticket, phase, ok }); } catch { /* evidence is best-effort */ } },
    merge: () => mergeMutex.runExclusive(async () => {
      const { mergeSha, preMergeSha } = await deps.mergeToIntegration({ ticket, branch: wt.branch, integrationBranch });
      const post = await deps.postMergeGate({ ticket, integrationBranch });
      if (!post.ok) {
        const rev = await deps.revertMerge({ integrationBranch, mergeSha, preMergeSha });
        return { ok: false, reverted: true, output: `post-merge gate failed; recovery=${rev.method}` };
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
  // Resume (adversarial-review L3): reuse the recorded run — its integration
  // branch, runId, and reconciled status — instead of starting fresh, so merged
  // tickets are not re-dispatched and the prior integration branch is continued.
  const resuming = !!(resume && resume.status && resume.integrationBranch);
  const integrationBranch = resuming ? resume.integrationBranch : integrationBranchName(runId);
  if (!resuming) {
    await deps.createIntegrationBranch?.({ integrationBranch, baseSha: config.baseSha });
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
    const outcome = await advanceTicket(ticket, buildEffects(ticket, wt, deps, integrationBranch, mergeMutex), { log });
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
  if (merged > 0 && deps.openPR) { deps.openPR({ integrationBranch, base: config.base }); prCount = 1; }

  return { integrationBranch, results, merged, prCount, status };
}
