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
import { classifyIssue } from './classify.mjs';
import { contentHash } from './content-hash.mjs';
import { globMatch, unitsForIssue } from './cluster.mjs';
import { verifyIssue } from './verify.mjs';
import { executeActions } from './execute.mjs';
import { assertFloor, assertFloorNotWidened, assertFrozenPathsNotNarrowed, assertPolicyUnchanged } from './floor.mjs';

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
    // §2.1: an issue whose cited paths are frozen is never auto-actioned. The
    // profile says those paths are off limits, and a close is an action on the
    // issue about them.
    if (issue.frozen === true) continue;
    out.push({
      number: issue.number,
      action: 'close',
      contentHash: issue.contentHash,
      evidence: typeof issue.evidence === 'string' ? issue.evidence : JSON.stringify(issue.evidence ?? null),
      updatedAt: issue.updatedAt ?? null,
      verdict: issue.verdict,
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
      updatedAt: issue.updatedAt ?? null,
      verdict: issue.verdict,
    });
  }

  return out;
}

/**
 * Re-derive, from the repository and a FRESHLY fetched issue, the facts the set
 * merely claims.
 *
 * THE SET IS A PROPOSAL, NOT A CAPABILITY. It is a JSON file on disk that any
 * caller can edit, so every security-relevant field in it — `frozen`,
 * `contentHash` — is a claim rather than evidence. Trusting them lets an edited
 * set unfreeze a protected path, or mint a fresh `contentHash` to buy a second
 * review for unchanged code and repeat until one approves.
 *
 * So the write path recomputes both from the issue's real body at HEAD and
 * refuses any action whose set disagrees. The set still chooses WHICH issues to
 * act on; it no longer gets to say what is true about them.
 *
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function revalidateAction(action, { fetchIssue, profile, io = {} } = {}) {
  let issue;
  try {
    issue = fetchIssue(action.number);
  } catch (err) {
    return { ok: false, reason: `could not re-read issue #${action.number}: ${err.message}` };
  }
  if (!issue) return { ok: false, reason: `issue #${action.number} could not be re-read` };

  const classified = classifyIssue(issue);
  const paths = (classified.references ?? []).map((r) => r.path);
  const fresh = contentHash(paths, io);

  if (fresh !== action.contentHash) {
    // Either the code moved under the set, or the set was edited. Both mean the
    // verdict in hand does not describe what is there now.
    return { ok: false, reason: `the issue's cited code no longer hashes to the set's contentHash (set ${action.contentHash}, now ${fresh})` };
  }

  const frozen = paths.some((path) => (profile?.frozenPaths ?? []).some((g) => globMatch(g, path)));
  if (frozen) return { ok: false, reason: `issue #${action.number} cites a frozen path` };

  const recomputed = verifyIssue(classified, io);

  if (action.action === 'relabel') {
    const relabel = revalidateRelabel(action, { issue, classified, recomputed, profile });
    if (!relabel.ok) return relabel;
  }

  // The issue's own revision, not only the code's. A body or label edited after
  // grooming leaves the repository untouched, so generatedFor still matches
  // while the verdict was formed from text that no longer exists. REQUIRED, not
  // checked-when-present: a set that omits it would otherwise skip the check.
  if (!action.updatedAt) {
    return { ok: false, reason: `the set declares no updatedAt for issue #${action.number}, so its issue revision cannot be checked` };
  }
  if (issue.updatedAt && issue.updatedAt !== action.updatedAt) {
    return { ok: false, reason: `issue #${action.number} changed since the set was generated (${action.updatedAt} → ${issue.updatedAt})` };
  }

  // THE VERDICT ITSELF, recomputed. Matching bytes and an unchanged issue prove
  // the set describes the right thing; they say nothing about whether its
  // CONCLUSION is right. Without this, a hand-written set can claim `fixed` for
  // an issue whose defect is still there, pass every other check, and close it.
  if (action.verdict && recomputed.verdict !== action.verdict) {
    return { ok: false, reason: `the set claims verdict ${action.verdict} for issue #${action.number}, but re-verification says ${recomputed.verdict}` };
  }
  if (action.action === 'close' && recomputed.verdict !== 'fixed') {
    return { ok: false, reason: `a close needs a re-verified 'fixed' verdict; issue #${action.number} re-verifies as ${recomputed.verdict}` };
  }

  return { ok: true };
}

/** The two relabel triggers §3.4a defines; nothing else produces a relabel. */
export const RELABEL_FIELDS = Object.freeze(['priority', 'area']);

/**
 * Re-derive a relabel's terms, rather than taking them from the set.
 *
 * `from`/`to` go straight into `gh issue edit --remove-label/--add-label`, and
 * `field` is part of the one-shot key, so each is a claim to check:
 *
 *  - FIELD is one of the two triggers, exactly. A free-form field is a free key:
 *    `priority`, `Priority` and `priority ` would be three one-shot slots for one
 *    relabel, and three reviews to ask until one approves.
 *  - Both labels belong to THAT field's class, so a priority slot cannot carry an
 *    area move or the reverse.
 *  - FROM is required and differs from TO. A relabel with no source only adds, and
 *    stacks a second priority label beside the first.
 *  - An AREA target is DERIVED: §3.4a calls it mechanically provable, so it must
 *    be proven here — the verified locations sit in exactly one unit, and the
 *    target is that unit. A declared label is not evidence the code lives there.
 *    A priority target is a rank judgment over the whole backlog and cannot be
 *    re-derived from one issue; it stays the reviewer's to judge.
 *
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function revalidateRelabel(action, { issue, classified, recomputed, profile } = {}) {
  const refuse = (reason) => ({ ok: false, reason: `relabel on issue #${action?.number}: ${reason}` });

  if (!RELABEL_FIELDS.includes(action?.field)) {
    return refuse(`field ${JSON.stringify(action?.field)} is not one of ${RELABEL_FIELDS.join(', ')}`);
  }
  if (typeof action.from !== 'string' || action.from === '') return refuse('a relabel must name the label it replaces');
  if (action.from === action.to) return refuse(`source and target are both ${JSON.stringify(action.to)}`);

  const areaPrefix = profile?.labels?.areaPrefix ?? 'area:';
  const units = profile?.units ?? [];
  const classLabels = action.field === 'priority'
    ? new Set(Object.values(profile?.labels?.priority ?? {}))
    : new Set(units.map((u) => `${areaPrefix}${u.name}`));

  if (!classLabels.has(action.to)) {
    return refuse(`target ${JSON.stringify(action.to)} is not a ${action.field} label this profile declares`);
  }
  if (!classLabels.has(action.from)) {
    return refuse(`source ${JSON.stringify(action.from)} is not a ${action.field} label this profile declares`);
  }

  // The label being removed must actually be on the issue right now.
  const current = (issue?.labels ?? []).map((l) => l?.name ?? l);
  if (!current.includes(action.from)) {
    return refuse(`the issue does not currently carry ${JSON.stringify(action.from)}`);
  }

  if (action.field === 'area') {
    const inUnits = unitsForIssue(recomputed, classified, units);
    if (inUnits.length !== 1) {
      return refuse(`the issue's verified locations do not sit in exactly one unit (${inUnits.length}), so no area move is provable`);
    }
    if (action.to !== `${areaPrefix}${inUnits[0]}`) {
      return refuse(`the verified locations sit in ${areaPrefix}${inUnits[0]}, not ${JSON.stringify(action.to)}`);
    }
  }

  return { ok: true };
}

/**
 * Gate every action, then execute the survivors.
 *
 * @param {object} o
 * @param {object} o.set - an emitted groomed set
 * @param {object} o.profile - parsed profile
 * @param {string[]|null} o.baseFloor - the floor at the merge base
 * @param {object|null} o.basePolicy - the profile at the merge base; its
 *   providers, labels and units must equal the working copy's
 * @param {object} o.ledger - the replay ledger (persisted by the caller)
 * @param {Function} o.runReview - injected reviewer, called with the ACTION so
 *   each review is bound to one issue rather than to the whole set
 * @param {object} o.gh - injected writer
 */
export function applyRun({ set, profile, baseFloor, basePolicy, ledger = {}, runReview, gh, revision = null, persist = null, fetchIssue = null, io = {}, self = null, baseFrozenPaths = null, key = null } = {}) {
  // A set describes ONE revision. Acting on a set generated against a different
  // one closes issues on evidence that no longer describes the code: the cited
  // file may have changed, or the defect may have been reintroduced, since the
  // verdict was computed.
  // REQUIRED, not merely checked when present: a set that omits generatedFor
  // would otherwise skip the staleness check entirely, which is the shape a
  // hand-crafted set takes.
  if (revision && !set?.generatedFor) {
    throw Object.assign(
      new Error('backlog-groom: this groomed set declares no generatedFor revision — refusing to act on evidence whose revision cannot be checked'),
      { isOpError: true }
    );
  }
  if (revision && set.generatedFor !== revision) {
    throw Object.assign(
      new Error(
        `backlog-groom: this groomed set was generated for ${set.generatedFor}, but the repository is at ${revision} — re-run the read path before applying`
      ),
      { isOpError: true }
    );
  }

  // `revision` spread LAST so a supplied io cannot unpin the snapshot every read
  // in this run is supposed to share — the same rule the read pipeline uses.
  const pinnedIo = revision ? { ...io, revision } : io;

  const proposed = actionsFromSet(set);

  // VALIDATE THE POLICY BEFORE SPENDING ANY REVIEW. The floor was previously
  // checked inside executeActions, after gating — so a misconfigured profile
  // burned every action's one shot and then refused the run, leaving those
  // revisions permanently demoted for a recoverable config error.
  assertFloor(profile.autonomyFloor);
  assertFloorNotWidened({ base: baseFloor, head: profile.autonomyFloor });
  if (baseFrozenPaths !== null) {
    assertFrozenPathsNotNarrowed({ base: baseFrozenPaths, head: profile.frozenPaths ?? [] });
  }
  // The rest of the policy is the base's too. The reviewer and the sanctioned
  // relabel targets are authorization terms, so a working copy that changes them
  // is the person being checked choosing how they are checked. REQUIRED: an
  // omitted base fails closed instead of skipping the comparison.
  assertPolicyUnchanged({ base: basePolicy, head: profile });

  // NO FAIL-OPEN SEAM. Without a way to re-read the issue there is no way to
  // check the set's claims, and proceeding would trust a file on disk for every
  // security-relevant fact — the exact hole re-validation exists to close.
  if (proposed.length > 0 && typeof fetchIssue !== 'function') {
    throw Object.assign(
      new Error('backlog-groom: no way to re-read issues, so the set\'s claims cannot be checked — refusing to act'),
      { isOpError: true }
    );
  }

  const revalidated = [];
  const stale = [];
  for (const action of proposed) {
    // The revision is PINNED into io: revalidation must read the same commit the
    // set was accepted against, or a checkout moving HEAD mid-run has every later
    // action validated against a different tree than the first.
    const check = revalidateAction(action, { fetchIssue, profile, io: pinnedIo });
    if (check.ok) revalidated.push(action);
    else stale.push({ number: action.number, action: action.action, reason: check.reason });
  }

  const gated = revalidated.map((action) => {
    const gate = gateAction({ action, profile, ledger, runReview: () => runReview(action), key });
    // Checkpoint BEFORE any write. A verdict that exists only in memory is a
    // verdict a crash erases, and the next run would review the same revision
    // again — the one-shot rule surviving only as long as the process does.
    persist?.(ledger);
    return { ...action, gate };
  });

  const result = executeActions({
    actions: gated,
    key,
    floor: profile.autonomyFloor,
    baseFloor,
    ledger,
    gh,
    onApplied: persist,
    self,
    // The window between validation and the write is where the issue can change
    // under us; this closes it as far as a two-step process can.
    recheck: (action) => revalidateAction(action, { fetchIssue, profile, io: pinnedIo }),
  });

  return {
    proposed: proposed.length,
    stale,
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
