// llm.mjs — LLM interaction for vacuous-method detection.
// Depends on @aidlc/core for complete/extractJson.

import { complete, extractJson } from '../../core/index.mjs';

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
 * Call the LLM to detect vacuous verification methods.
 *
 * @param {Array<{line:number, text:string}>} verifiedCriteria
 * @returns {Promise<{ vacuous: number[], reason: Record<string,string> }>}
 */
export async function detectVacuous(verifiedCriteria) {
  if (verifiedCriteria.length === 0) {
    return { vacuous: [], reason: {} };
  }

  const prompt = buildVacuousPrompt(verifiedCriteria);
  const response = await complete({
    tier: 'cheap',
    system: 'You are a spec quality auditor. Respond with JSON only.',
    prompt,
    maxTokens: 1024,
  });

  const parsed = extractJson(response);
  return {
    vacuous: Array.isArray(parsed?.vacuous) ? parsed.vacuous : [],
    reason: parsed?.reason ?? {},
  };
}
