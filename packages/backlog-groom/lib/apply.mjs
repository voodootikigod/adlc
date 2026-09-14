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
import { ACTION_CLASSES } from './floor.mjs';
import { executeActions } from './execute.mjs';

/**
 * Actions the emitted set proposes, in the shape the gate and executor expect.
 *
 * `close` is derived from a `fixed` verdict; the set's own `proposals` carry
 * relabels and relations. An issue with no contentHash yields no action at all —
 * §2.2 leaves it with no revision to bind a verdict to, so it can neither be
 * gated nor replay-protected.
 */
/**
 * Action classes the writer can actually perform.
 *
 * Narrower than ACTION_CLASSES on purpose: the FLOOR must know about every class
 * the tool might ever take, so an operator can pre-emptively block one, while
 * the EXECUTOR must only accept what it can really do. An action accepted here
 * and refused at the writer would comment its rationale and then fail, leaving
 * a "relabelling because…" note on an issue whose labels never changed.
 */
export const EXECUTABLE_ACTIONS = Object.freeze(['close', 'relabel']);

export function actionsFromSet(set) {
  const out = [];
  const byNumber = new Map((set?.issues ?? []).map((i) => [i.number, i]));

  for (const issue of set?.issues ?? []) {
    if (issue.verdict !== 'fixed') continue;
    if (!issue.contentHash) continue;
    // §2.1: an issue whose cited paths are frozen is never auto-actioned. The
    // profile says those paths are off limits, and a close is an action on the
    // issue about them.
    if (issue.frozen === true) continue;
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
    if (issue.frozen === true) continue;
    // Refused HERE, before a comment is written — not at the writer, which would
    // leave a rationale on an issue nothing then happened to.
    if (!EXECUTABLE_ACTIONS.includes(p.action)) continue;
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
 * @param {Function} o.runReview - injected reviewer, called with the ACTION so
 *   each review is bound to one issue rather than to the whole set
 * @param {object} o.gh - injected writer
 */
export function applyRun({ set, profile, baseFloor, ledger = {}, runReview, gh, floorWideningAuthorized = false, revision = null, persist = null } = {}) {
  // A set describes ONE revision. Acting on a set generated against a different
  // one closes issues on evidence that no longer describes the code: the cited
  // file may have changed, or the defect may have been reintroduced, since the
  // verdict was computed.
  if (revision && set?.generatedFor && set.generatedFor !== revision) {
    throw Object.assign(
      new Error(
        `backlog-groom: this groomed set was generated for ${set.generatedFor}, but the repository is at ${revision} — re-run the read path before applying`
      ),
      { isOpError: true }
    );
  }

  const proposed = actionsFromSet(set);

  const gated = proposed.map((action) => {
    const gate = gateAction({ action, profile, ledger, runReview: () => runReview(action) });
    // Checkpoint BEFORE any write. A verdict that exists only in memory is a
    // verdict a crash erases, and the next run would review the same revision
    // again — the one-shot rule surviving only as long as the process does.
    persist?.(ledger);
    return { ...action, gate };
  });

  const result = executeActions({
    actions: gated,
    floor: profile.autonomyFloor,
    baseFloor,
    floorWideningAuthorized,
    ledger,
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
