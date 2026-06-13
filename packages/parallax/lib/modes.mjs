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
 * Run the shared divergence analysis over N fan readings.
 * Parses each result; tolerates per-call failures (needs >=2 ok readings).
 * Then runs one mid-tier divergence call.
 *
 * @param {string} fanPrompt - The prompt sent to each fan agent.
 * @param {object} opts - { n, tier, divergenceTier }
 * @returns {Promise<{ agreements, divergences, score, readings, errors }>}
 */
export async function runDivergenceAnalysis(fanPrompt, { n = 3, tier = 'cheap', divergenceTier = 'mid' } = {}) {
  const fanResults = await fan({ prompt: fanPrompt, tier }, n);

  const { readings, errors } = parseFanResults(fanResults);

  if (readings.length < 2) {
    throw new Error(
      `need at least 2 successful readings, got ${readings.length}. Errors: ${errors.join('; ')}`
    );
  }

  // Run divergence analysis with mid-tier
  const divergencePrompt = buildDivergencePrompt(readings);
  const divergenceRaw = await complete({ prompt: divergencePrompt, tier: divergenceTier });
  const divergenceResult = extractJson(divergenceRaw);

  const agreements = divergenceResult.agreements ?? [];
  const divergences = divergenceResult.divergences ?? [];
  const score = computeScore(divergences.length, agreements.length);

  return { agreements, divergences, score, readings, errors };
}

/**
 * SPEC MODE: fan N cheap agents on the feature request, then divergence-analyse.
 * @param {string} request - Feature request text.
 * @param {object} opts - { n, tier }
 * @returns {Promise<{ agreements, divergences, score, readings, errors }>}
 */
export async function runSpecMode(request, opts = {}) {
  const fanPrompt = buildSpecReaderPrompt(request);
  return runDivergenceAnalysis(fanPrompt, opts);
}

/**
 * EDGE MODE: fan N cheap agents on the pair of tickets, then divergence-analyse.
 * @param {object} ticketA
 * @param {object} ticketB
 * @param {object} opts - { n, tier }
 * @returns {Promise<{ agreements, divergences, score, readings, errors }>}
 */
export async function runEdgeMode(ticketA, ticketB, opts = {}) {
  const fanPrompt = buildEdgePrompt(ticketA, ticketB);
  return runDivergenceAnalysis(fanPrompt, opts);
}

/**
 * ROUTE MODE: fan N cheap agents to answer the question, then judge equivalence.
 * @param {string} question
 * @param {Array<{path: string, content: string}>} contextFiles
 * @param {object} opts - { n, tier }
 * @returns {Promise<{ equivalent, answer, variants, rawAnswers }>}
 */
export async function runRouteMode(question, contextFiles = [], opts = {}) {
  const { n = 3, tier = 'cheap' } = opts;

  const answerPrompt = buildRouteAnswerPrompt(question, contextFiles);
  const fanResults = await fan({ prompt: answerPrompt, tier }, n);

  const { rawAnswers, errors } = parseFanAnswers(fanResults);

  if (rawAnswers.length < 2) {
    throw new Error(
      `need at least 2 successful answers, got ${rawAnswers.length}. Errors: ${errors.join('; ')}`
    );
  }

  const judgePrompt = buildRouteJudgePrompt(question, rawAnswers);
  const judgeRaw = await complete({ prompt: judgePrompt, tier });
  const judgeResult = extractJson(judgeRaw);

  return {
    equivalent: Boolean(judgeResult.equivalent),
    answer: judgeResult.answer ?? '',
    variants: judgeResult.variants ?? [],
    rawAnswers,
    errors,
  };
}
