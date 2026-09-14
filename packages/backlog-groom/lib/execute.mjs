/**
 * Execution (§3.8) — comment first, then act, idempotently.
 *
 * ORDER IS THE CONTRACT. The comment carrying the evidence and the rationale
 * goes on the issue BEFORE the action, never after, so a wrong action is
 * self-documenting and easy to challenge. An issue that goes quiet without a
 * trail is the failure this ordering exists to prevent.
 *
 * IDEMPOTENCE IS A DESIGN CONSTRAINT, NOT A NICETY. The two writes are not
 * atomic: a comment can land and the action then fail — rate limit, revoked
 * token, a human closing it first — leaving an issue carrying a "closing
 * because…" comment in an open state. A re-run must detect its own marker for
 * that `(issue, contentHash)` and resume AT THE ACTION rather than
 * re-commenting, or the backlog accumulates a duplicate rationale with every
 * retry. `scripts/ceremony-drift.mjs` solved this shape first and names
 * idempotence as its whole design constraint.
 *
 * STRUCTURE follows ceremony-drift too: the decisions are pure and live above
 * (`planAction`), and the I/O shell below is deliberately branch-free, so the
 * contracts are testable without a GitHub token.
 */

import { assertFloor, assertFloorNotWidened, blockedByFloor } from './floor.mjs';

/**
 * The exported functions that can cause a GitHub write.
 *
 * DECLARED, not inferred, and asserted by the floor suite: every exported
 * function must appear here or in PURE_HELPERS. The weak form of "one validator,
 * every entry point" enumerates the callers that exist today and says nothing
 * about the third one added next year; forcing every new export to be classified
 * is the version that still works after everyone who wrote it has moved on.
 */
export const WRITE_ENTRY_POINTS = Object.freeze(['executeActions']);

/** Exported functions that cannot write — pure decisions and formatting. */
export const PURE_HELPERS = Object.freeze(['marker', 'parseMarker', 'planAction', 'renderComment']);

const MARKER_PREFIX = 'backlog-groom';

/** The durable idempotence marker for one issue at one revision. */
export function marker(number, contentHash) {
  return `<!-- ${MARKER_PREFIX}:${number}:${contentHash} -->`;
}

/** Parse a marker back, or null. */
export function parseMarker(text) {
  const m = /<!--\s*backlog-groom:(\d+):([^\s>]+?)\s*-->/.exec(String(text ?? ''));
  return m ? { number: Number(m[1]), contentHash: m[2] } : null;
}

/** The comment body: the evidence, the rationale, and the marker. */
export function renderComment(action) {
  return [
    `**backlog-groom — ${action.action}**`,
    '',
    action.evidence ?? '(no evidence recorded)',
    '',
    action.gate?.reviewer ? `Reviewed by \`${action.gate.reviewer}\` (distinct from the deciding provider).` : '',
    marker(action.number, action.contentHash),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Decide whether one action may execute. Pure — no I/O.
 *
 * The floor is consulted BEFORE the gate verdict is honoured, because the two
 * answer different questions: the gate is evidence about the conclusion, the
 * floor is the operator's policy about who may act on evidence at all. A
 * sufficiently confident reviewer must not be able to talk past a policy.
 */
export function planAction(action, { floor = [] } = {}) {
  if (blockedByFloor(action?.action, floor)) return { do: false, reason: 'floor' };
  if (action?.gate?.verdict !== 'approve') return { do: false, reason: 'gate' };
  return { do: true, reason: null };
}

/**
 * Apply every action the gate licensed and the floor permits.
 *
 * @param {object} o
 * @param {object[]} o.actions - gated actions
 * @param {string[]} o.floor - the working-copy autonomy floor
 * @param {string[]|null} o.baseFloor - the floor at the MERGE BASE (§3.7/AC24)
 * @param {boolean} [o.floorWideningAuthorized] - explicit trust-root authorization
 * @param {object} o.gh - `{comments(number), comment(number, body), apply(number, action)}`
 * @returns {{executed:object[], demoted:object[], failed:object[]}}
 */
export function executeActions({ actions = [], floor = [], baseFloor = null, floorWideningAuthorized = false, gh } = {}) {
  // Validate and compare BEFORE any write. A run must not apply its first
  // action and discover the policy problem on its second — a half-applied sweep
  // under a floor nobody authorised is worse than a refused one.
  assertFloor(floor);
  assertFloorNotWidened({ base: baseFloor, head: floor, authorized: floorWideningAuthorized });

  const executed = [];
  const demoted = [];
  const failed = [];

  for (const action of actions) {
    const plan = planAction(action, { floor });
    if (!plan.do) {
      demoted.push({ number: action.number, action: action.action, reason: plan.reason });
      continue;
    }

    // Resume rather than re-comment: our own marker for THIS revision means the
    // rationale is already on the issue and only the action is outstanding.
    let alreadyCommented = false;
    try {
      const existing = gh.comments(action.number) ?? [];
      const want = marker(action.number, action.contentHash);
      alreadyCommented = existing.some((body) => String(body).includes(want));
    } catch (err) {
      // Unable to read the issue's comments means unable to tell a resume from a
      // first run, and guessing "first run" duplicates the rationale.
      failed.push({ number: action.number, action: action.action, reason: `could not read existing comments: ${err.message}` });
      continue;
    }

    if (!alreadyCommented) {
      try {
        gh.comment(action.number, renderComment(action));
      } catch (err) {
        failed.push({ number: action.number, action: action.action, reason: err.message });
        continue;
      }
    }

    try {
      gh.apply(action.number, action.action);
    } catch (err) {
      // The comment is on the issue and the action is not. That is the
      // resumable state by design: a re-run finds the marker and retries only
      // the action.
      failed.push({ number: action.number, action: action.action, reason: err.message, resumable: true });
      continue;
    }

    executed.push({ number: action.number, action: action.action, resumed: alreadyCommented });
  }

  return { executed, demoted, failed };
}
