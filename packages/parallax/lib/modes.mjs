// Mode implementations for parallax: spec, edge, route.
// These functions handle the LLM orchestration; they are async and have side
// effects (network calls). Pure logic lives in prompts.mjs and scoring.mjs.

import { fan, complete, extractJson } from '@adlc/core';
import {
  buildSpecReaderPrompt,
  buildDivergencePrompt,
  buildEdgePrompt,
  buildRouteAnswerPrompt,
  buildRouteJudgePrompt,
} from './prompts.mjs';
import { computeScore } from './scoring.mjs';

/**
 * Parse raw fan results into readings, collecting per-call errors.
 * Tolerates per-call failures; returns { readings, errors }.
 * Pure function — testable without network.
 *
 * @param {Array<{ok: boolean, value?: string, error?: string}>} fanResults
 * @returns {{ readings: object[], errors: string[] }}
 */
export function parseFanResults(fanResults) {
  const readings = [];
  const errors = [];
  for (const result of fanResults) {
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    try {
      const parsed = extractJson(result.value);
      readings.push(parsed);
    } catch (err) {
      errors.push(`parse error: ${err.message}`);
    }
  }
  return { readings, errors };
}

/**
 * Parse raw route fan results (plain text answers), collecting per-call errors.
 * Pure function — testable without network.
 *
 * @param {Array<{ok: boolean, value?: string, error?: string}>} fanResults
 * @returns {{ rawAnswers: string[], errors: string[] }}
 */
export function parseFanAnswers(fanResults) {
  const rawAnswers = [];
  const errors = [];
  for (const result of fanResults) {
    if (!result.ok) {
      errors.push(result.error);
    } else {
      rawAnswers.push(result.value);
    }
  }
  return { rawAnswers, errors };
}

/**
 * Validate a divergence-analysis payload (issue #705).
 *
 * The mid-tier divergence call is asked for `{agreements: [...], divergences:
 * [...]}`, but `extractJson` succeeds on ANY JSON — a refusal object, a
 * truncated `{}`, a bare array, a `{result: ...}` wrapper. Reading those two
 * fields with `?? []` turned every one of them into "zero divergences, zero
 * agreements", which computeScore reports as 0 and the gate reports as PASS.
 * Nothing downstream could tell "the readings converged" from "the analysis
 * produced nothing measurable".
 *
 * So: a payload that does not actually carry both arrays is an OPERATIONAL
 * failure (the caller turns this into exit 1), never a score.
 *
 * Pure: returns a reason string when the payload is unusable, else null.
 *
 * @param {unknown} result
 * @returns {string|null}
 */
export function divergencePayloadError(result) {
  const expected = 'expected {agreements:[...], divergences:[...]}';
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return `divergence analysis returned an off-schema payload (${expected}, got ${describe(result)})`;
  }
  const missing = [];
  if (!Array.isArray(result.agreements)) missing.push('agreements');
  if (!Array.isArray(result.divergences)) missing.push('divergences');
  if (missing.length === 0) return null;
  return `divergence analysis returned an off-schema payload (${expected}; ${missing.join(' and ')} missing or not an array)`;
}

/** Short, non-throwing description of an off-schema value for an error message. */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Validate the effective fan width (issue #706).
 *
 * Sampling diversity is this tool's whole instrument: the score is
 * divergences / (divergences + agreements) across N independent readings. A
 * fan that silently shrinks — rate limit, timeout, off-schema JSON — measures
 * a SMALLER sample, which yields a systematically lower ambiguity score, i.e.
 * it biases toward exit 0. Parking the failures in a `warnings` array a machine
 * consumer is free to ignore is not a signal.
 *
 * So a verdict is refused when fewer readings survived than were requested,
 * unless the operator opted in with --allow-partial-fan.
 *
 * Pure: returns a reason string when the fan is too narrow to certify, else null.
 *
 * @param {object} params
 * @param {number} params.requested   readings asked for (--n)
 * @param {number} params.used        readings that survived parsing
 * @param {string[]} [params.errors]  the per-call failures, for the message
 * @param {boolean} [params.allowPartialFan]
 * @returns {string|null}
 */
export function fanWidthError({ requested, used, errors = [], allowPartialFan = false }) {
  if (allowPartialFan) return null;
  if (used >= requested) return null;
  const detail = errors.length > 0 ? ` Errors: ${errors.join('; ')}` : '';
  return (
    `fan shrank to ${used} of ${requested} requested readings; refusing a verdict ` +
    `(pass --allow-partial-fan to accept a narrowed sample).${detail}`
  );
}

/**
 * Resolve the LLM callables the modes use.
 *
 * Production always gets the real `fan`/`complete` from @adlc/core. Two seams
 * exist so the orchestration itself — not just the pure predicates above — can
 * be exercised without a provider:
 *
 *   1. `deps` — an explicit `{fan, complete}` pair passed by a unit test.
 *   2. ADLC_GATE_MOCK_RESPONSE — honored ONLY when NODE_ENV === 'test', the
 *      same TEST-ONLY contract packages/coldstart/lib/gate.mjs documents, so
 *      CLI integration tests can drive full output and exit-code paths. In any
 *      non-test run the variable is IGNORED and the real LLM path is taken;
 *      ambient, agent-controlled env data must never be able to manufacture a
 *      passing gate. scripts/run-tests.mjs scrubs it from every segment that
 *      does not set it inline.
 *
 * The mock fails closed exactly like the real path: an unparseable or
 * shape-deviant mock is an unreadable analysis, not an empty one.
 *
 * @param {{fan?: Function, complete?: Function}} [deps]
 * @param {object} [env]
 * @returns {{fan: Function, complete: Function}}
 */
export function resolveDeps(deps, env = process.env) {
  if (deps?.fan && deps?.complete) return deps;
  const mockEnv = env.ADLC_GATE_MOCK_RESPONSE;
  if (mockEnv !== undefined && env.NODE_ENV === 'test') return buildMockDeps(mockEnv);
  return { fan, complete };
}

/** Parse the TEST-ONLY mock payload into a {fan, complete} pair, failing closed. */
function buildMockDeps(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ADLC_GATE_MOCK_RESPONSE is not valid JSON (${err.message})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ADLC_GATE_MOCK_RESPONSE must be an object of {fan, divergence|judge}');
  }
  if (!Array.isArray(parsed.fan)) {
    throw new Error('ADLC_GATE_MOCK_RESPONSE.fan must be an array of fan results');
  }
  const single = parsed.divergence ?? parsed.judge;
  if (single === undefined) {
    throw new Error('ADLC_GATE_MOCK_RESPONSE must carry a `divergence` or `judge` payload');
  }
  return {
    async fan() {
      return parsed.fan;
    },
    async complete() {
      return JSON.stringify(single);
    },
  };
}

/**
 * Run the shared divergence analysis over N fan readings.
 *
 * Refuses (throws, which the CLI surfaces as exit 1) rather than scoring when
 * the fan shrank below the requested width (#706) or the divergence payload is
 * off-schema (#705). The absolute >=2 floor remains the innermost guard: two
 * readings are the minimum a comparison can be drawn from at all.
 *
 * @param {string} fanPrompt - The prompt sent to each fan agent.
 * @param {object} opts - { n, tier, divergenceTier, allowPartialFan, deps }
 * @returns {Promise<{ agreements, divergences, score, readings, errors, requested, used }>}
 */
export async function runDivergenceAnalysis(
  fanPrompt,
  { n = 3, tier = 'cheap', divergenceTier = 'mid', allowPartialFan = false, deps } = {}
) {
  const llm = resolveDeps(deps);
  const fanResults = await llm.fan({ prompt: fanPrompt, tier }, n);

  const { readings, errors } = parseFanResults(fanResults);

  const widthError = fanWidthError({ requested: n, used: readings.length, errors, allowPartialFan });
  if (widthError) throw new Error(widthError);

  if (readings.length < 2) {
    throw new Error(
      `need at least 2 successful readings, got ${readings.length}. Errors: ${errors.join('; ')}`
    );
  }

  // Run divergence analysis with mid-tier
  const divergencePrompt = buildDivergencePrompt(readings);
  const divergenceRaw = await llm.complete({ prompt: divergencePrompt, tier: divergenceTier });
  const divergenceResult = extractJson(divergenceRaw);

  const payloadError = divergencePayloadError(divergenceResult);
  if (payloadError) throw new Error(payloadError);

  const { agreements, divergences } = divergenceResult;
  const score = computeScore(divergences.length, agreements.length);

  return { agreements, divergences, score, readings, errors, requested: n, used: readings.length };
}

/**
 * SPEC MODE: fan N cheap agents on the feature request, then divergence-analyse.
 * @param {string} request - Feature request text.
 * @param {object} opts - { n, tier, allowPartialFan, deps }
 * @returns {Promise<{ agreements, divergences, score, readings, errors, requested, used }>}
 */
export async function runSpecMode(request, opts = {}) {
  const fanPrompt = buildSpecReaderPrompt(request);
  return runDivergenceAnalysis(fanPrompt, opts);
}

/**
 * EDGE MODE: fan N cheap agents on the pair of tickets, then divergence-analyse.
 * @param {object} ticketA
 * @param {object} ticketB
 * @param {object} opts - { n, tier, allowPartialFan, deps }
 * @returns {Promise<{ agreements, divergences, score, readings, errors, requested, used }>}
 */
export async function runEdgeMode(ticketA, ticketB, opts = {}) {
  const fanPrompt = buildEdgePrompt(ticketA, ticketB);
  return runDivergenceAnalysis(fanPrompt, opts);
}

/**
 * ROUTE MODE: fan N cheap agents to answer the question, then judge equivalence.
 *
 * The same shrunken-fan refusal applies here (#706): "the answers agreed" is
 * the passing branch, and fewer answers means fewer chances to disagree, so a
 * narrowed sample biases this gate toward exit 0 exactly as it does the
 * divergence score.
 *
 * @param {string} question
 * @param {Array<{path: string, content: string}>} contextFiles
 * @param {object} opts - { n, tier, contextCap, allowPartialFan, deps }
 * @returns {Promise<{ equivalent, answer, variants, rawAnswers, errors, requested, used }>}
 */
export async function runRouteMode(question, contextFiles = [], opts = {}) {
  const { n = 3, tier = 'cheap', allowPartialFan = false, deps } = opts;
  const { contextCap } = opts;
  const llm = resolveDeps(deps);

  const answerPrompt = buildRouteAnswerPrompt(question, contextFiles, { contextCap });
  const fanResults = await llm.fan({ prompt: answerPrompt, tier }, n);

  const { rawAnswers, errors } = parseFanAnswers(fanResults);

  const widthError = fanWidthError({ requested: n, used: rawAnswers.length, errors, allowPartialFan });
  if (widthError) throw new Error(widthError);

  if (rawAnswers.length < 2) {
    throw new Error(
      `need at least 2 successful answers, got ${rawAnswers.length}. Errors: ${errors.join('; ')}`
    );
  }

  const judgePrompt = buildRouteJudgePrompt(question, rawAnswers);
  const judgeRaw = await llm.complete({ prompt: judgePrompt, tier });
  const judgeResult = extractJson(judgeRaw);

  return {
    equivalent: Boolean(judgeResult.equivalent),
    answer: judgeResult.answer ?? '',
    variants: judgeResult.variants ?? [],
    rawAnswers,
    errors,
    requested: n,
    used: rawAnswers.length,
  };
}
