/**
 * The `apply` run — the CLI's write entry point, assembled (§3.6–§3.8).
 *
 *   proposals → gate (one shot each) → floor → comment-first execute → report
 *
 * Every external effect is injected, so the whole write path is testable
 * without a GitHub token, a reviewer subprocess, or a git tree.
 *
 * This module is the CLI's route to `executeActions`, which is what makes AC6
 * true in both directions: the floor validator is not something the library
 * happens to call and the CLI happens to skip. There is exactly one execution
 * function and both callers reach the writer through it.
 */

import { gateAction } from './gate.mjs';
import { executeActions } from './execute.mjs';

/**
 * Actions the emitted set proposes, in the shape the gate and executor expect.
 *
 * `close` is derived from a `fixed` verdict; the set's own `proposals` carry
 * relabels and relations. An issue with no contentHash yields no action at all —
 * §2.2 leaves it with no revision to bind a verdict to, so it can neither be
 * gated nor replay-protected.
 */
export function actionsFromSet(set) {
  const out = [];
  const byNumber = new Map((set?.issues ?? []).map((i) => [i.number, i]));

  for (const issue of set?.issues ?? []) {
    if (issue.verdict !== 'fixed') continue;
    if (!issue.contentHash) continue;
    out.push({
      number: issue.number,
      action: 'close',
      contentHash: issue.contentHash,
      evidence: typeof issue.evidence === 'string' ? issue.evidence : JSON.stringify(issue.evidence ?? null),
    });
  }

  for (const p of set?.proposals ?? []) {
    const issue = byNumber.get(p.number);
    if (!issue?.contentHash) continue;
    out.push({
      number: p.number,
      action: p.action,
      contentHash: issue.contentHash,
      evidence: p.evidence ?? null,
      field: p.field ?? null,
      from: p.from ?? null,
      to: p.to ?? null,
    });
  }

  return out;
}

/**
 * Gate every action, then execute the survivors.
 *
 * @param {object} o
 * @param {object} o.set - an emitted groomed set
 * @param {object} o.profile - parsed profile
 * @param {string[]|null} o.baseFloor - the floor at the merge base
 * @param {object} o.ledger - the replay ledger (persisted by the caller)
 * @param {Function} o.runReview - injected reviewer
 * @param {object} o.gh - injected writer
 */
export function applyRun({ set, profile, baseFloor, ledger = {}, runReview, gh, floorWideningAuthorized = false } = {}) {
  const proposed = actionsFromSet(set);

  const gated = proposed.map((action) => ({
    ...action,
    gate: gateAction({ action, profile, ledger, runReview }),
  }));

  const result = executeActions({
    actions: gated,
    floor: profile.autonomyFloor,
    baseFloor,
    floorWideningAuthorized,
    gh,
  });

  return {
    proposed: proposed.length,
    ...result,
    // The demoted set is the interesting half of the report: it is where this
    // tool's judgment and an independent reviewer disagreed. Surfacing the
    // reason alongside keeps that legible instead of a bare count.
    gateDemotions: gated.filter((a) => a.gate?.verdict !== 'approve').map((a) => ({
      number: a.number,
      action: a.action,
      reason: a.gate?.reason ?? 'no gate verdict',
    })),
  };
}
