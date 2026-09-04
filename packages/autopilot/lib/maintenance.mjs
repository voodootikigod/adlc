// Maintenance glue (spec §8): the two retry protocols lib/maintain.mjs calls
// back into, built from the same round steps as the initial run.
//
//   conflictFixRound — a DIRTY rebase: exactly one fleet dispatch carrying the
//                      conflict markers as dead-end material, then the full
//                      tail (completion → review → attest → gates → push).
//   retryRound       — a clean rebase whose patch-id changed: no dispatch; the
//                      rebased head is reviewed, attested, gated and pushed
//                      afresh (a fresh `record-cross-model`, never carry-forward).

import { validateIssueNumber } from './input.mjs';
import { createRunSteps } from './round.mjs';
import { CI_FIX_WALL_MINUTES } from './ci.mjs';

export async function stepsFor({ ctx, deps, record }) {
  const n = validateIssueNumber(record.issue);
  const ticket = record.ticketCache ?? { scope: [] };
  const mirror = await deps.mirror.createWorkerMirror({ ctx, issue: n });
  const workerDeps = await deps.deps.buildWorkerDeps({ ctx, issue: n, baseOid: ctx.baseOid });
  return createRunSteps({ ctx, deps, issue: n, ticket, ticketId: record.ticketId, mirror, workerDeps, revision: record.issueRevision ?? null });
}

/** One conflict-fix dispatch (§8, AC 7). Returns { ok, attestedHead } | { ok:false, code }. */
export async function conflictFixRound({ ctx, deps, record, deadEnd }) {
  let steps;
  try { steps = await stepsFor({ ctx, deps, record }); } catch (e) { return { ok: false, code: e.code ?? 'init-failed' }; }
  const file = await deps.deadEnd({ ctx, issue: record.issue, text: deadEnd });
  const r = await steps.round({ budget: { strikes: 1, wallClockMinutes: CI_FIX_WALL_MINUTES, wallClockMs: CI_FIX_WALL_MINUTES * 60_000 }, deadEndFile: file, chargeGlobal: false });
  if (r.status !== 'attested') return { ok: false, code: r.status === 'terminal' ? (r.result.reason ?? r.result.state) : 'conflict-fix-needs-another-round' };
  const p = await steps.pushAndOpen({ attested: r.attested, review: r.review });
  if (p.status === 'terminal') return { ok: false, code: p.result.reason ?? p.result.state };
  return { ok: true, attestedHead: r.attested.attestedHead };
}

/** A full retry round without a dispatch (§8, AC 48): review → attest → gates → push on the rebased head. */
export async function retryRound({ ctx, deps, record, reason }) {
  let steps;
  try { steps = await stepsFor({ ctx, deps, record }); } catch (e) { return { ok: false, code: e.code ?? 'init-failed' }; }
  const r = await steps.attestTail({ head: record.localHead, reason });
  if (r.status !== 'attested') return { ok: false, code: r.status === 'terminal' ? (r.result.reason ?? r.result.state) : 'retry-needs-a-round', deadEndFile: r.deadEndFile ?? null };
  const p = await steps.pushAndOpen({ attested: r.attested, review: r.review });
  if (p.status === 'terminal') return { ok: false, code: p.result.reason ?? p.result.state };
  return { ok: true, attestedHead: r.attested.attestedHead };
}

/** The `deps` object lib/maintain.mjs consumes, bound to the context's module set. */
export function maintenanceDeps({ ctx, deps }) {
  return {
    actualDiffCheck: deps.diffcheck.actualDiffCheck,
    retireRun: deps.retire.retireRun,
    applyTerminalEffects: deps.effects.applyTerminalEffects,
    conflictFixRound: ({ record, deadEnd }) => conflictFixRound({ ctx, deps, record, deadEnd }),
    retryRound: ({ record, reason }) => retryRound({ ctx, deps, record, reason }),
  };
}
