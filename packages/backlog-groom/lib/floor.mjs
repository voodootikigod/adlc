/**
 * The autonomy floor — the ONE validator every write entry point runs (§3.7).
 *
 * The floor lists action classes that always require a human REGARDLESS of the
 * reviewer's verdict. It is deliberately the last check rather than the first:
 * a gate approval is evidence about the conclusion, and the floor is a statement
 * about who is allowed to act on evidence at all. Those are different questions
 * and collapsing them would let a sufficiently confident reviewer talk its way
 * past an operator's policy.
 *
 * Shaped after `packages/model-router/lib/floor.mjs`, which solved the same
 * problem for the P3 rail-density gate, and for the same three reasons:
 *
 *  1. ONE validator, called by every entry point, so a library caller cannot
 *     execute what the CLI would have blocked.
 *  2. Disabling is EXPLICIT. An omitted key yields the conservative default
 *     (the profile parser owns that); only a deliberate `[]` empties the floor.
 *     A permissive floor must never be reachable by a missing key or a typo.
 *  3. Invalid input is an OPERATIONAL ERROR, never a silently dropped entry.
 *     `model-router` refuses `parseFloat` because it would accept `0.5abc` as
 *     `0.5`; the enum analogue is that `"clsoe"` must not quietly leave closing
 *     unguarded while the file appears to say otherwise.
 */

/** Every action class the write path can perform. */
export const ACTION_CLASSES = Object.freeze(['close', 'relabel', 'duplicate-link', 'comment']);

/**
 * The floor an omitted `autonomyFloor` key produces.
 *
 * Closing is the default because it is the one action nobody re-reads: a
 * relabel is visible on the issue forever, while a wrongly-closed issue leaves
 * the backlog and is never looked at again.
 */
export const DEFAULT_AUTONOMY_FLOOR = Object.freeze(['close']);

function opError(message) {
  return Object.assign(new Error(message), { isOpError: true });
}

/**
 * Validate a floor, returning it unchanged.
 *
 * @param {unknown} floor
 * @returns {string[]}
 * @throws {Error & {isOpError:true}} on a non-array, an unknown class, or a duplicate
 */
export function assertFloor(floor) {
  if (!Array.isArray(floor)) {
    throw opError(
      `backlog-groom: autonomyFloor must be an array of action classes — known classes are: ${ACTION_CLASSES.join(', ')}`
    );
  }
  const seen = new Set();
  for (const cls of floor) {
    if (!ACTION_CLASSES.includes(cls)) {
      throw opError(
        `backlog-groom: unknown action class ${JSON.stringify(cls)} in autonomyFloor — known classes are: ${ACTION_CLASSES.join(', ')}`
      );
    }
    // A duplicate is harmless to dedupe and harmful to hide. The same
    // inattention that writes a class twice writes it wrong once, and that case
    // is not harmless — so both are surfaced rather than tidied away.
    if (seen.has(cls)) {
      throw opError(`backlog-groom: autonomyFloor lists ${JSON.stringify(cls)} more than once`);
    }
    seen.add(cls);
  }
  return floor;
}

/**
 * True when `action` may not execute autonomously under `floor`.
 *
 * Fails closed on the QUERY as well as on the config: an action class the floor
 * has never heard of is not "absent from the floor", it is unrecognised, and
 * treating unrecognised as permitted is precisely how a newly-added action
 * ships without anyone deciding whether it should be autonomous.
 */
export function blockedByFloor(action, floor) {
  if (!ACTION_CLASSES.includes(action)) return true;
  return (floor ?? DEFAULT_AUTONOMY_FLOOR).includes(action);
}

/**
 * The classes present at the merge base and absent at HEAD — i.e. the widening.
 *
 * @returns {string[]} empty when the head floor is narrower than or equal to the base
 */
export function floorWidening(base, head) {
  const headSet = new Set(head ?? []);
  return (base ?? []).filter((cls) => !headSet.has(cls));
}

/**
 * Refuse a floor widened relative to the MERGE BASE (§3.7, AC24).
 *
 * The comparison is against the base and not the working copy because the
 * working copy is exactly what someone widening the floor controls: a check
 * that reads only the checked-out profile validates the attacker's own claim.
 *
 * `authorized` is a LIBRARY seam for tests and is deliberately NOT reachable from
 * the CLI. A flag that waives the check is not a weaker version of the trust-root
 * path — it is a complete bypass of it, available to anyone who can type. The
 * real path to a wider floor is to land the profile change on the default
 * branch: once the base carries it, there is no widening left to detect.
 *
 * It is not a profile key either, for the same reason the comparison is against
 * the base rather than the working copy: a key inside the profile granting
 * permission to widen that same profile is circular.
 *
 * @param {{base: string[]|null, head: string[], authorized?: boolean}} o
 */
export function assertFloorNotWidened({ base, head, authorized = false } = {}) {
  if (!Array.isArray(base)) {
    // "Unreadable" is not "empty". Treating an unknown base as no-floor would
    // make DELETING the profile at the merge base the cheapest possible
    // widening — the check would congratulate the very move it exists to catch.
    throw opError(
      'backlog-groom: could not read the autonomy floor at the merge base — refusing to act, because an unknown base floor cannot be shown to be narrower'
    );
  }
  const widened = floorWidening(base, head);
  if (widened.length === 0) return head;
  if (authorized) return head;
  throw opError(
    `backlog-groom: autonomyFloor is WIDER than at the merge base — ${widened.join(', ')} ` +
      'no longer requires a human. Widening the floor is a privileged change and needs explicit trust-root authorization.'
  );
}

/**
 * Frozen paths removed relative to the merge base.
 *
 * The same asymmetry the floor uses, for the same reason. `frozenPaths` marks
 * issues that are never auto-actioned, so DELETING an entry is exactly as
 * privileged as removing a class from the floor — and guarding one while
 * leaving the other editable just moves the escalation one key down the file.
 */
export function frozenPathsRemoved(base, head) {
  const headSet = new Set(head ?? []);
  return (base ?? []).filter((g) => !headSet.has(g));
}

/** Refuse a profile that unfreezes paths relative to the merge base. */
export function assertFrozenPathsNotNarrowed({ base, head, authorized = false } = {}) {
  if (!Array.isArray(base)) {
    throw opError('backlog-groom: could not read frozenPaths at the merge base — refusing to act on an unknown baseline');
  }
  const removed = frozenPathsRemoved(base, head);
  if (removed.length === 0 || authorized) return head;
  throw opError(
    `backlog-groom: frozenPaths no longer covers ${removed.join(', ')} — unfreezing a path is a privileged change and needs explicit trust-root authorization.`
  );
}
