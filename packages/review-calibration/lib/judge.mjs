// review-calibration/lib/judge.mjs
// Semantic match: does a reviewer finding identify THIS planted defect?
// Recognition (finding + defect both given) is far easier than generation
// (find the bug) — the generator–verifier gap — so a cheap model judges well.
// The judge is itself calibrated against a labeled fixture (calibrateJudge).

/**
 * A judge is `async (plant, finding) => boolean` — true iff the finding
 * identifies the plant's defect.
 */

const JUDGE_SYSTEM =
  'You are calibrating a code reviewer. Given a known planted defect and one ' +
  'review finding, decide whether the finding actually IDENTIFIES that defect ' +
  '(names the wrong behavior / root cause), not merely that it mentions the ' +
  'same line. Echoing or quoting a changed line without describing what is ' +
  'wrong is NOT identifying it. Answer only JSON: {"match": true|false}.';

function buildJudgePrompt(plant, finding) {
  return [
    'PLANTED DEFECT',
    `  file: ${plant.file}:${plant.line}`,
    `  category: ${plant.category ?? 'unknown'}`,
    `  change: ${oneLine(plant.original)}  ->  ${oneLine(plant.mutated)}`,
    `  what is wrong: ${plant.defect ?? '(no description)'}`,
    '',
    'REVIEW FINDING',
    `  at: ${finding.file}:${finding.line}`,
    `  says: ${oneLine(finding.description)}`,
    finding.evidence ? `  evidence: ${oneLine(finding.evidence)}` : '',
    '',
    'Does this finding identify the planted defect? JSON {"match": true|false}.',
  ].filter(Boolean).join('\n');
}

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Build an LLM-backed judge from a completion function + JSON extractor
 * (e.g. core's `complete` / `extractJson`).
 *
 * @param {Function} completeFn   async ({tier, system, prompt, maxTokens}) => string
 * @param {Function} extractJsonFn (text) => object
 * @returns {(plant, finding) => Promise<boolean>}
 */
export function makeLlmJudge(completeFn, extractJsonFn) {
  return async function judge(plant, finding) {
    const raw = await completeFn({
      tier: 'cheap',
      system: JUDGE_SYSTEM,
      prompt: buildJudgePrompt(plant, finding),
      maxTokens: 64,
    });
    const parsed = extractJsonFn(raw);
    return parsed?.match === true;
  };
}

/**
 * Deterministic reference judge used by the control self-test (no network).
 * A finding identifies a defect iff its description references the defect's
 * meaning — approximated as containing a content token from the defect text
 * beyond the bare location. An echo finding ("file:line changed") contains no
 * such token and is correctly rejected; the oracle's defect description is
 * accepted. This is a TEST DOUBLE for the LLM judge — it exercises the scorer's
 * aggregation, proving it has no string-match shortcut that bypasses judgment.
 *
 * @param {object} plant
 * @param {object} finding
 * @returns {boolean}
 */
export function referenceJudge(plant, finding) {
  const desc = oneLine(finding.description).toLowerCase();
  if (!desc) return false;
  const tokens = defectTokens(plant);
  if (tokens.length === 0) return false;
  return tokens.some((t) => desc.includes(t));
}

/** Content words (>=4 chars) from the defect description + category. */
export function defectTokens(plant) {
  const text = `${plant.defect ?? ''} ${plant.category ?? ''}`.toLowerCase();
  const stop = new Set(['this', 'that', 'with', 'from', 'into', 'line', 'code', 'changed', 'change']);
  return [...new Set(
    text.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !stop.has(w))
  )];
}

/**
 * Calibrate a judge against a labeled fixture of (plant, finding, expected)
 * triples. Returns agreement with the labels so the recall number can carry
 * the measured reliability of the judge that produced it. Bottoms out the
 * "who judges the judge" regress: matching is easy and the fixture is small.
 *
 * @param {Array<{plant:object, finding:object, expected:boolean}>} fixture
 * @param {(plant, finding) => (boolean|Promise<boolean>)} judge
 * @returns {Promise<{agreement:number, n:number, disagreements:Array}>}
 */
export async function calibrateJudge(fixture, judge) {
  let agree = 0;
  const disagreements = [];
  for (const { plant, finding, expected } of fixture) {
    const got = await judge(plant, finding);
    if (got === expected) agree++;
    else disagreements.push({ plant: plant.file, finding: finding.file, expected, got });
  }
  const n = fixture.length;
  return { agreement: n > 0 ? agree / n : 0, n, disagreements };
}
