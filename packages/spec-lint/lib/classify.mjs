// classify.mjs — decide whether a criterion is VERIFIED or WISH.
// Pure functions; no I/O.

/**
 * Patterns that indicate a verification method is present.
 *
 * A criterion is VERIFIED if its text contains ANY of:
 *   1. A backtick command  → `something`
 *   2. A test/spec file path  → foo.test.js / bar.spec.ts etc.
 *   3. 'verify:' or 'verified by' followed by text
 *   4. 'test:' followed by text
 *   5. The phrase 'exit code'
 *   6. The word 'assert'
 */

const BACKTICK_RE = /`[^`]+`/;
const SPEC_FILE_RE = /\.(test|spec)\.[a-z]+/i;
const VERIFY_RE = /(?:verify\s*:|verified\s+by)\s+\S/i;
const TEST_LABEL_RE = /test\s*:\s*\S/i;
const EXIT_CODE_RE = /exit\s+code/i;
const ASSERT_RE = /\bassert\b/i;

/**
 * @param {string} text  Criterion text.
 * @returns {{ verified: boolean, reason: string }}
 */
export function classifyCriterion(text) {
  if (BACKTICK_RE.test(text)) {
    return { verified: true, reason: 'contains backtick command' };
  }
  if (SPEC_FILE_RE.test(text)) {
    return { verified: true, reason: 'references test/spec file' };
  }
  if (VERIFY_RE.test(text)) {
    return { verified: true, reason: 'contains verify:/verified by' };
  }
  if (TEST_LABEL_RE.test(text)) {
    return { verified: true, reason: 'contains test: label' };
  }
  if (EXIT_CODE_RE.test(text)) {
    return { verified: true, reason: 'mentions exit code' };
  }
  if (ASSERT_RE.test(text)) {
    return { verified: true, reason: 'contains assert' };
  }
  return { verified: false, reason: 'no verification method found' };
}

/**
 * Classify an array of parsed criteria.
 *
 * @param {Array<{line: number, text: string, source: string}>} criteria
 * @returns {Array<{line: number, text: string, source: string, status: 'VERIFIED'|'WISH', reason: string}>}
 */
export function classifyAll(criteria) {
  return criteria.map(c => {
    const { verified, reason } = classifyCriterion(c.text);
    return { ...c, status: verified ? 'VERIFIED' : 'WISH', reason };
  });
}

/**
 * Apply LLM demotion results: vacuous VERIFIED → WISH.
 *
 * @param {Array<{line:number, text:string, status:string, reason:string}>} classified
 * @param {{ vacuous: number[], reason: Record<string,string> }} llmResult
 *   indices are 0-based into the VERIFIED subset (the array passed to the LLM).
 * @param {number[]} verifiedIndices  Original indices into `classified` for each
 *   entry sent to the LLM (0-based into `classified`).
 * @returns {Array}  New array with demoted entries.
 */
export function applyLlmDemotion(classified, llmResult, verifiedIndices) {
  const result = classified.map(c => ({ ...c }));
  const vacuousSet = new Set(llmResult.vacuous ?? []);

  for (const [subIdx, origIdx] of verifiedIndices.entries()) {
    if (vacuousSet.has(subIdx)) {
      result[origIdx] = {
        ...result[origIdx],
        status: 'WISH',
        reason: llmResult.reason?.[String(subIdx)] ?? 'demoted: vacuous verification method',
      };
    }
  }
  return result;
}
