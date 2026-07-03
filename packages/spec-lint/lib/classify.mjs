// classify.mjs — decide whether a criterion is VERIFIED or WISH.
// Pure functions; no I/O.

/**
 * Patterns that indicate a verification method is present.
 *
 * A criterion is VERIFIED if its text contains ANY of:
 *   1. A backtick span that looks like a command/assertion  → `npm test`
 *   2. A test/spec file path  → foo.test.js / bar.spec.ts etc.
 *   3. 'verify:' or 'verified by' followed by text
 *   4. 'test:' followed by text
 *   5. The phrase 'exit code'
 *   6. The word 'assert'
 *
 * A bare backtick span alone is NOT sufficient (#45) — an unrelated code
 * span (e.g. a filename like `vitest.config.ts` mentioned in passing) must
 * not count as a verification method. The span must look like a command or
 * assertion, or be introduced by phrasing like "Verified via"/"Run ".
 */

const BACKTICK_RE = /`[^`]+`/g;
const SPEC_FILE_RE = /\.(test|spec)\.[a-z]+/i;
const VERIFY_RE = /(?:verify\s*:|verified\s+by)\s+\S/i;
const TEST_LABEL_RE = /test\s*:\s*\S/i;
const EXIT_CODE_RE = /exit\s+code/i;
const ASSERT_RE = /\bassert\b/i;

/**
 * Words that suggest the backtick span itself is a command/assertion,
 * rather than a bare filename or other incidental code span.
 */
const COMMAND_WORD_RE =
  /\b(run|npm|npx|yarn|pnpm|node|python|pytest|curl|wget|make|cargo|go|sh|bash|git|docker|kubectl|jest|mocha|rspec|dotnet|ruby|java|test|check|verify|assert|exec|deploy|build|lint|ci)\b/i;
/** A CLI flag, e.g. "--card=valid" or "-v". */
const FLAG_RE = /(?:^|[\s(])--?[A-Za-z][\w-]*/;
/** Shell pipe/redirection operators. */
const SHELL_OP_RE = /[|><]/;
/** A function-call shape, e.g. "db.write()". */
const CALL_RE = /\w\(\)/;
/**
 * Phrasing immediately preceding a backtick span that implies it's being
 * run/checked. `\b` guards the `run` alternative so words that merely END in
 * "run" (overrun, underrun, rerun) don't falsely satisfy it.
 */
const PRECEDING_PHRASE_RE = /(verified\s+via|\brun)\s*:?\s*$/i;
/**
 * A backtick span whose entire content is a single bare filename/path token
 * (no whitespace) — e.g. `vitest.config.ts`, `ci-config.yaml`, `/var/log/run`.
 * These must not be treated as a genuine command merely because a
 * COMMAND_WORD_RE token happens to appear as a path/kebab-case segment
 * (e.g. "ci", "build", "go", "run" inside a filename) — see #45 follow-up.
 */
const FILENAME_LIKE_RE = /^[\w][\w./-]*\.[A-Za-z0-9]+$/;
/** A bare absolute/relative path with no whitespace and no file extension. */
const PATH_LIKE_RE = /^\.{0,2}\/[\w./-]+$/;

/**
 * Whether a backtick span in `text` looks like a genuine command or
 * assertion, rather than an incidental code span (e.g. a bare filename).
 *
 * @param {string} text  Full criterion text.
 * @param {RegExpExecArray} backtickMatch  A single backtick match (from
 *   iterating all matches of `BACKTICK_RE` over `text`).
 * @returns {boolean}
 */
function looksLikeVerificationCommand(text, backtickMatch) {
  const content = backtickMatch[0].slice(1, -1);
  const before = text.slice(0, backtickMatch.index);
  const isFileLike = FILENAME_LIKE_RE.test(content) || PATH_LIKE_RE.test(content);
  return (
    (!isFileLike && COMMAND_WORD_RE.test(content)) ||
    FLAG_RE.test(content) ||
    SHELL_OP_RE.test(content) ||
    CALL_RE.test(content) ||
    PRECEDING_PHRASE_RE.test(before)
  );
}

/**
 * @param {string} text  Criterion text.
 * @returns {{ verified: boolean, reason: string }}
 */
export function classifyCriterion(text) {
  // Inspect EVERY backtick span, not just the first — a genuine verification
  // command can appear after an earlier, incidental backtick span (e.g. a
  // filename mentioned before a `npm test` invocation). See #45 follow-up.
  const backtickMatches = [...text.matchAll(BACKTICK_RE)];
  if (backtickMatches.some(m => looksLikeVerificationCommand(text, m))) {
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
