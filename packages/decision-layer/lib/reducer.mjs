// The reducer: (status, answers, pack) -> allow | escalate | unknown, plus the
// action each phase the pack describes would take (`wouldAct`). Deterministic
// and pure. Nothing performs `wouldAct` in shadow mode; it is recorded only.

/** The spec's phase-action table. */
export const PHASE_ACTIONS = Object.freeze({
  P0: Object.freeze({ allow: 'keep-deterministic-triage', escalate: 'recommend-deeper-interrogation', unknown: 'record-inconclusive' }),
  D1: Object.freeze({ allow: 'keep-deterministic-assignment', escalate: 'recommend-one-tier-up', unknown: 'keep-deterministic-assignment' }),
});

function matches(condition, answer) {
  if (!answer) return false;
  const valueMatches = 'equals' in condition
    ? answer.value === condition.equals
    : (condition.atLeast === undefined || answer.value >= condition.atLeast)
      && (condition.atMost === undefined || answer.value <= condition.atMost);
  if (!valueMatches) return false;
  if (condition.minProbability === undefined) return true;
  return typeof answer.probability === 'number' && answer.probability >= condition.minProbability;
}

function outcomeOf(status, answers, aggregation) {
  if (status !== 'ok') return 'unknown';
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const holds = (condition) => matches(condition, byId.get(condition.question));
  if (aggregation.escalateIf.some(holds)) return 'escalate';
  if (aggregation.allowIf.length > 0 && aggregation.allowIf.every(holds)) return 'allow';
  return 'unknown';
}

/**
 * @param {{ status: 'ok'|'unknown'|'error', answers: Array<{ id: string, value: unknown, probability?: number }>, pack: object }} input
 * @returns {{ outcome: 'allow'|'escalate'|'unknown', wouldAct: Record<string, string> }}
 */
export function reduce({ status, answers, pack }) {
  const outcome = outcomeOf(status, answers, pack.aggregation);
  const phases = [...new Set(pack.questions.flatMap((question) => question.phases))];
  const wouldAct = Object.fromEntries(phases.map((phase) => [phase, PHASE_ACTIONS[phase][outcome]]));
  return { outcome, wouldAct };
}
