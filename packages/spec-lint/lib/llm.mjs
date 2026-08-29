// llm.mjs — LLM interaction for vacuous-method detection.
// Depends on @adlc/core for complete/extractJson.

import { complete, extractJson } from '@adlc/core';

/**
 * Build the prompt for vacuous-method detection.
 *
 * @param {Array<{line:number, text:string}>} verifiedCriteria
 *   The VERIFIED criteria to inspect (0-based indices used as references).
 * @returns {string}
 */
export function buildVacuousPrompt(verifiedCriteria) {
  const items = verifiedCriteria
    .map((c, i) => `${i}: ${c.text}`)
    .join('\n');

  return `You are a spec quality auditor. Below are acceptance criteria that contain a \
verification marker (a command, test file, or keyword). Some verifications are \
VACUOUS — they name a method but describe it so vaguely that it could never \
actually be run or would always pass (e.g. "works correctly", "run tests", \
"verify it functions", "check that it is correct").

Identify which indices have vacuous verification methods. Return JSON only:
{ "vacuous": [<0-based index>, ...], "reason": { "<index>": "<one sentence>" } }
If none are vacuous, return { "vacuous": [], "reason": {} }

Criteria:
${items}`;
}

/**
 * Validate and coerce a parsed LLM response into a usable vacuous-vote
 * payload. FAILS CLOSED (throws) on anything unusable rather than silently
 * treating it as "nothing vacuous" — a missing/misshaped `vacuous` field, or
 * any element that isn't a valid index, is an "I could not read the verdict"
 * signal, not a "the verdict was empty" one (issue #774).
 *
 * A bare top-level array response is deliberately NOT recovered here (unlike
 * coldstart's #594 fix, which recovers a bare array because its prompt is
 * ambiguous about shape) — this package's prompt explicitly asks for
 * {"vacuous": [...], "reason": {...}}, so a bare array is a genuine shape
 * violation worth surfacing, not a plausible deviation to special-case.
 *
 * @param {*} parsed - the parsed JSON response (any shape)
 * @param {number} verifiedCount - length of the criteria array sent to the LLM;
 *   every vacuous index must be an integer in [0, verifiedCount)
 * @returns {{ vacuous: number[], reason: Record<string,string> }}
 *   vacuous indices are numeric (numeric-string entries are coerced) so
 *   `Set.has(subIdx)` comparisons in classify.mjs work regardless of how the
 *   model encoded them.
 * @throws {Error} with a message identifying the specific problem
 */
export function validateVacuousPayload(parsed, verifiedCount) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'vacuous-vote payload is missing its "vacuous" field (top-level response must be an object with a "vacuous" array, not a bare array or scalar)'
    );
  }
  if (!('vacuous' in parsed) || parsed.vacuous === null || parsed.vacuous === undefined) {
    throw new Error('vacuous-vote payload is missing its "vacuous" field');
  }
  if (!Array.isArray(parsed.vacuous)) {
    throw new Error(`vacuous-vote payload's "vacuous" field must be an array, got ${typeof parsed.vacuous}`);
  }

  const vacuous = parsed.vacuous.map((raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      throw new Error(`vacuous-vote payload contains a non-numeric or non-integer index: ${JSON.stringify(raw)}`);
    }
    if (n < 0 || n >= verifiedCount) {
      throw new Error(`vacuous-vote payload contains an out-of-range index ${n} (verified count is ${verifiedCount})`);
    }
    return n;
  });

  return { vacuous, reason: parsed.reason ?? {} };
}

/**
 * Call the LLM to detect vacuous verification methods.
 *
 * @param {Array<{line:number, text:string}>} verifiedCriteria
 * @param {string} [tier]
 * @param {object} [opts]
 * @param {Function} [opts.completeFn] - injectable, default core's complete()
 * @param {Function} [opts.extractJsonFn] - injectable, default core's extractJson()
 * @returns {Promise<{ vacuous: number[], reason: Record<string,string> }>}
 * @throws {Error} if the LLM response cannot be validated (see validateVacuousPayload)
 */
export async function detectVacuous(verifiedCriteria, tier = 'cheap', opts = {}) {
  const { completeFn = complete, extractJsonFn = extractJson } = opts;

  if (verifiedCriteria.length === 0) {
    return { vacuous: [], reason: {} };
  }

  const prompt = buildVacuousPrompt(verifiedCriteria);
  const response = await completeFn({
    tier,
    system: 'You are a spec quality auditor. Respond with JSON only.',
    prompt,
    maxTokens: 1024,
  });

  const parsed = extractJsonFn(response);
  return validateVacuousPayload(parsed, verifiedCriteria.length);
}
