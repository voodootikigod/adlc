// review-calibration/lib/judge.mjs
// Semantic match: does a reviewer finding identify THIS planted defect?
// Recognition (finding + defect both given) is far easier than generation
// (find the bug) — the generator–verifier gap — so a cheap model judges well.
// The judge is itself calibrated against a labeled fixture (calibrateJudge).

import { resolveModel } from '@adlc/core';

/**
 * A judge is `async (plant, finding) => boolean` — true iff the finding
 * identifies the plant's defect.
 */

export const JUDGE_SYSTEM =
  'You are calibrating a code reviewer. Given a known planted defect and one ' +
  'review finding, decide whether the finding actually IDENTIFIES that defect ' +
  '(names the wrong behavior / root cause), not merely that it mentions the ' +
  'same line. Echoing or quoting a changed line without describing what is ' +
  'wrong is NOT identifying it. Answer only JSON: {"match": true|false}.';

export function buildJudgePrompt(plant, finding) {
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
 * @param {string} [tier]
 * @returns {(plant, finding) => Promise<boolean>}
 */
export function makeLlmJudge(completeFn, extractJsonFn, tier = 'cheap') {
  return async function judge(plant, finding) {
    const raw = await completeFn({
      tier,
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

// ── provider-independence guard (issue #64) ───────────────────────────────────
// The judge is resolved through the same auto-detect provider path as
// everything else in the toolkit, while the reviewer-under-test runs as an
// opaque subprocess via --review-cmd — it can't be introspected generically.
// The caller states its provider explicitly via --review-provider; this
// compares that declaration against the judge's resolved provider so the
// "who reviews the reviewer" claim can't be silently satisfied by the same
// model family reviewing itself.

/** Known aliases that name the same provider family as `detectProvider`. */
const PROVIDER_ALIASES = new Map([
  ['claude', 'anthropic'],
  ['gpt', 'openai'],
  ['gpt4', 'openai'],
  ['chatgpt', 'openai'],
  ['google', 'gemini'],
]);

function normalizeProviderName(name) {
  const n = String(name).trim().toLowerCase();
  return PROVIDER_ALIASES.get(n) ?? n;
}

/**
 * Compare the caller-declared reviewer-under-test provider against the
 * judge's resolved provider. Neither side can be compared if undeclared
 * (a missing --review-provider, or a judge that isn't LLM-backed, e.g.
 * --scorer string) — in that case `same` is false because no comparison was
 * possible, not because independence was verified.
 *
 * @param {string|undefined} reviewProvider  caller-declared --review-provider value
 * @param {string|undefined} judgeProvider   judge's resolved provider name (detectProvider().name)
 * @returns {{ same: boolean, reviewProvider: string|undefined, judgeProvider: string|undefined }}
 */
export function checkProviderIndependence(reviewProvider, judgeProvider) {
  if (!reviewProvider || !judgeProvider) {
    return { same: false, reviewProvider, judgeProvider };
  }
  return {
    same: normalizeProviderName(reviewProvider) === normalizeProviderName(judgeProvider),
    reviewProvider,
    judgeProvider,
  };
}

/** Substring → family, checked against the actual model name agy dispatches to. */
const MODEL_FAMILY_PATTERNS = [
  [/claude/, 'anthropic'],
  [/gemini/, 'gemini'],
  [/gpt/, 'openai'],
];

/**
 * Resolve the judge's EFFECTIVE provider family for `checkProviderIndependence`.
 *
 * `detectProvider().name` is a literal identifier ('anthropic' | 'openai' |
 * 'gemini' | 'agy') — accurate for the three API-key providers, whose name
 * already equals the model family they call. The 'agy' provider is different:
 * it proxies to the Antigravity CLI, whose ACTUAL model family is tier-dependent
 * (see packages/core/lib/llm.mjs PROVIDERS[3].models — models.cheap is
 * Gemini-family while models.mid/frontier are Claude/anthropic-family). Passing
 * the literal string 'agy' into checkProviderIndependence would never match a
 * declared --review-provider, silently defeating the guard exactly when agy is
 * transparently running the same model family as the reviewer-under-test.
 *
 * Resolves the ACTUAL model id `complete()` will dispatch to — via core's
 * `resolveModel`, which checks `ADLC_MODEL_<TIER>` env overrides FIRST and only
 * falls back to the provider's static `models[tier]` table when unset — then
 * matches that model id against known family substrings. Using the static
 * table directly (without the override) would let an operator's
 * `ADLC_MODEL_MID=<openai-model>` override silently defeat the guard: the judge
 * would actually run on OpenAI while this function kept reporting 'anthropic'.
 * Falls back to the literal provider name (never silently claims independence)
 * when the provider isn't 'agy' or its resolved model name doesn't match a
 * known family.
 *
 * @param {{name: string, models?: Record<string,string>}|null|undefined} provider  detectProvider() result
 * @param {string} tier
 * @param {NodeJS.ProcessEnv} [env]  defaults to process.env; accepts ADLC_MODEL_<TIER> overrides
 * @returns {string|undefined}
 */
export function resolveEffectiveProvider(provider, tier, env = process.env) {
  if (!provider) return undefined;
  if (provider.name !== 'agy') return provider.name;
  let modelId;
  try {
    modelId = resolveModel(provider, { tier }, env);
  } catch {
    return provider.name; // unknown tier — fall back, don't guess a match
  }
  const model = String(modelId ?? '').toLowerCase();
  for (const [pattern, family] of MODEL_FAMILY_PATTERNS) {
    if (pattern.test(model)) return family;
  }
  return provider.name; // unrecognized model name — fall back, don't guess a match
}
