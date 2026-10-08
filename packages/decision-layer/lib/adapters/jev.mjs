// The Jev provider: TypeSafe's System One API over native fetch, built against
// the live responses in test/fixtures/jev-live-2026-10-08.json.
//
// It translates in both directions and judges nothing itself: evaluateDecision
// still validates every answer against the pack and decides the status.
//
// Request. TypeSafe judges one `state` per call, and each question may see only
// the input fields it declares, so questions are grouped by identical input and
// each group is one call. A Choice question's labels become its criteria; a
// Noul question is sent as a yes/no question; a Score question is sent as its
// integer levels min..max, which TypeSafe allows only 2 to 10 of.
//
// Reply. A Choice answer is its choice, with that choice's probability. A Noul
// answer is TypeSafe's P(yes) = p: `yes` with probability p when p >= 0.5,
// otherwise `no` with probability 1 - p. A tie counts as `yes`, so a coin flip
// escalates rather than passes. A Score answer is min plus TypeSafe's weighted
// level position. The model TypeSafe reports is the resolved model; usage keeps
// its token counts.
//
// Failures. No response (a network error) is `network`; 429 and 529 are
// `rate-limit`; any other 5xx is `network`: all three are `unknown` and are
// retried. Any other non-2xx status (a rejected key, a refused request) is a
// rejection, which is `error`, as is a 2xx body that is not JSON.
import { MAX_TOTAL_BYTES } from '../pack.mjs';

export const DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const MAX_RESPONSE_BYTES = 65_536;
const RATE_LIMITED = new Set([429, 529]);
const SCORE_LEVELS = { min: 2, max: 10 };

const round = (value) => Math.round(value * 1e6) / 1e6;

/** @returns {{ type: string, instructions: string, criteria?: object }} the TypeSafe form of one question */
export function typesafeQuestion({ id, kind, prompt, domain }) {
  if (kind === 'Choice') return { type: 'choice', instructions: prompt, criteria: Object.fromEntries(domain.map((label) => [label, label])) };
  if (kind === 'Noul') return { type: 'noul', instructions: prompt };
  const levels = domain.max - domain.min + 1;
  if (!Number.isInteger(domain.min) || !Number.isInteger(domain.max) || levels < SCORE_LEVELS.min || levels > SCORE_LEVELS.max) {
    throw new UnsupportedQuestion(`Score question "${id}" needs an integer domain of ${SCORE_LEVELS.min} to ${SCORE_LEVELS.max} levels for Jev`);
  }
  return { type: 'score', instructions: prompt, criteria: Array.from({ length: levels }, (_, index) => String(domain.min + index)) };
}

class UnsupportedQuestion extends Error {}

/** Questions grouped by identical input; each group is one TypeSafe call. */
export function typesafeRequests(request) {
  const groups = new Map();
  for (const question of request.questions) {
    const key = JSON.stringify(question.input);
    const group = groups.get(key) ?? { model: request.model, state: question.input, questions: {} };
    group.questions[question.id] = typesafeQuestion(question);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function noulAnswer(id, answer) {
  const p = answer.noul;
  if (typeof p !== 'number') return { id, kind: 'Noul', value: p };
  return p >= 0.5
    ? { id, kind: 'Noul', value: 'yes', probability: p }
    : { id, kind: 'Noul', value: 'no', probability: round(1 - p) };
}

function neutralAnswer(id, answer, question) {
  if (answer === null || typeof answer !== 'object') return { id, value: answer };
  const confidence = answer.confidence === undefined ? {} : { confidence: answer.confidence };
  if (answer.type === 'choice') {
    const probability = answer.probabilities?.[answer.choice];
    return { id, kind: 'Choice', value: answer.choice, ...(probability === undefined ? {} : { probability }), ...confidence };
  }
  if (answer.type === 'noul') return noulAnswer(id, answer);
  if (answer.type === 'score') {
    const value = typeof answer.score === 'number' && question?.domain ? question.domain.min + answer.score : answer.score;
    return { id, kind: 'Score', value, ...confidence };
  }
  return { id, kind: String(answer.type), value: undefined };
}

function neutralUsage(usage) {
  if (usage === null || typeof usage !== 'object') return usage;
  return {
    ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
  };
}

function sumUsage(usages) {
  const present = usages.filter((usage) => usage !== undefined);
  if (present.length === 0) return undefined;
  if (present.some((usage) => usage === null || typeof usage !== 'object')) return present.find((usage) => usage === null || typeof usage !== 'object');
  const total = {};
  for (const usage of present) {
    for (const [key, value] of Object.entries(usage)) total[key] = typeof total[key] === 'number' && typeof value === 'number' ? total[key] + value : value;
  }
  return total;
}

/**
 * Translate TypeSafe replies (one per group) into the neutral reply body that
 * evaluateDecision validates. An answer TypeSafe omitted stays missing, so the
 * neutral validation rejects it; differing resolved models are passed on as an
 * invalid model so the run is `error`.
 */
export function neutralBody(replies, request) {
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  const answers = [];
  const models = new Set();
  for (const reply of replies) {
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return reply;
    if (reply.model !== undefined) models.add(reply.model);
    const replyAnswers = reply.answers;
    if (replyAnswers === null || typeof replyAnswers !== 'object' || Array.isArray(replyAnswers)) return { answers: replyAnswers };
    for (const [id, answer] of Object.entries(replyAnswers)) answers.push(neutralAnswer(id, answer, questions.get(id)));
  }
  const usage = sumUsage(replies.map((reply) => (reply.usage === undefined ? undefined : neutralUsage(reply.usage))));
  return {
    answers,
    ...(models.size === 0 ? {} : { resolvedModel: models.size === 1 ? [...models][0] : [...models].join(' ') }),
    ...(usage === undefined ? {} : { usage }),
  };
}

async function readBounded(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return { tooLarge: true };
  return { text };
}

async function post({ fetchImpl, apiUrl, apiKey, signal }, body) {
  let response;
  try {
    response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
  } catch {
    return { failure: 'network' };
  }
  if (RATE_LIMITED.has(response.status)) return { failure: 'rate-limit' };
  if (response.status >= 500) return { failure: 'network' };
  if (response.status < 200 || response.status >= 300) return { rejected: `http-${response.status}` };
  const { text, tooLarge } = await readBounded(response).catch(() => ({ network: true }));
  if (tooLarge) return { rejected: 'response-too-large' };
  if (text === undefined) return { failure: 'network' };
  try {
    return { reply: JSON.parse(text) };
  } catch {
    return { rejected: 'malformed-response' };
  }
}

/**
 * @param {{ apiKey: string, apiUrl?: string, fetch?: typeof fetch }} options
 * @returns {{ name: 'jev', call: (request: object, options?: { signal?: AbortSignal }) => Promise<{ body: unknown } | { failure: string } | { rejected: string }> }}
 */
export function createJevProvider({ apiKey, apiUrl = DEFAULT_API_URL, fetch: fetchImpl = globalThis.fetch }) {
  return {
    name: 'jev',
    async call(request, { signal } = {}) {
      let groups;
      try {
        groups = typesafeRequests(request);
      } catch (error) {
        if (error instanceof UnsupportedQuestion) return { rejected: 'unsupported-question' };
        throw error;
      }
      if (groups.some((group) => Buffer.byteLength(JSON.stringify(group), 'utf8') > MAX_TOTAL_BYTES)) return { rejected: 'request-too-large' };
      const replies = [];
      for (const group of groups) {
        const outcome = await post({ fetchImpl, apiUrl, apiKey, signal }, group);
        if (!outcome.reply) return outcome;
        replies.push(outcome.reply);
      }
      return { body: neutralBody(replies, request) };
    },
  };
}
