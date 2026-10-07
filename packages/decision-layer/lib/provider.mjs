// The provider-neutral call path and the adapter contract's status rules.
//
// A provider's call() resolves to { body } (a reply arrived) or { failure }
// (none did: 'timeout', 'rate-limit' or 'network'). No reply is `unknown`; a
// reply that is unusable is `error`. Neither ever carries a fabricated answer.
// Rate-limit and network failures are retried at most MAX_RETRIES times; a
// call that has not answered within timeoutMs is a timeout, never retried.
//
// Each question is sent only the input fields it declares. A model ID ending
// in -<major>.<minor>.<patch> is pinned: a reply that resolves it to any other
// model is `error`. Any other ID is an alias, which may resolve to anything.
// The resolved model is whatever the reply reported, kept even when the reply
// is otherwise unusable, and null when no reply arrived or none was reported.
import { isPlainObject } from '@adlc/core';

export const MAX_RETRIES = 2;
export const DEFAULT_TIMEOUT_MS = 10_000;
const PINNED_MODEL = /-\d+\.\d+\.\d+$/;
const DEFAULT_RETRY_DELAY_MS = 250;
const RETRYABLE = new Set(['rate-limit', 'network']);
const BODY_KEYS = new Set(['answers', 'resolvedModel', 'usage']);
const ANSWER_KEYS = new Set(['id', 'kind', 'value', 'probability', 'confidence']);

/** A model ID ending in -<major>.<minor>.<patch> names one immutable model. */
export function isPinnedModel(model) {
  return PINNED_MODEL.test(model);
}

class UnusableReply extends Error {
  constructor(errorClass, message) {
    super(message);
    this.errorClass = errorClass;
  }
}

const isUnitInterval = (value) => typeof value === 'number' && value >= 0 && value <= 1;
const malformed = (message) => new UnusableReply('malformed-response', message);

function inDomain(question, value) {
  if (question.kind === 'Score') return typeof value === 'number' && value >= question.domain.min && value <= question.domain.max;
  return question.domain.includes(value);
}

function normalizeAnswer(answer, question) {
  if (!isPlainObject(answer)) throw malformed('every answer must be an object');
  for (const key of Object.keys(answer)) {
    if (!ANSWER_KEYS.has(key)) throw malformed(`unexpected answer field "${key}"`);
  }
  if (answer.kind !== undefined && answer.kind !== question.kind) throw malformed(`answer "${question.id}" has kind ${answer.kind}, expected ${question.kind}`);
  for (const key of ['probability', 'confidence']) {
    if (answer[key] !== undefined && !isUnitInterval(answer[key])) throw malformed(`answer "${question.id}" ${key} must be between 0 and 1`);
  }
  if (!inDomain(question, answer.value)) throw new UnusableReply('out-of-domain', `answer "${question.id}" is outside its domain`);
  return {
    id: question.id,
    kind: question.kind,
    value: answer.value,
    ...(answer.probability === undefined ? {} : { probability: answer.probability }),
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
  };
}

/** Exactly one answer per declared question, in pack order; throws UnusableReply otherwise. */
function normalizeReply(body, pack) {
  if (!isPlainObject(body)) throw malformed('the reply must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.has(key)) throw malformed(`unexpected reply field "${key}"`);
  }
  if (!Array.isArray(body.answers)) throw malformed('the reply must carry an answers list');
  if (body.resolvedModel !== undefined && typeof body.resolvedModel !== 'string') throw malformed('resolvedModel must be a string');
  if (body.usage !== undefined && !isPlainObject(body.usage)) throw malformed('usage must be an object');
  const questions = new Map(pack.questions.map((question) => [question.id, question]));
  const byId = new Map();
  for (const answer of body.answers) {
    const question = questions.get(answer?.id);
    if (!question) throw malformed(`answer for an undeclared question ${JSON.stringify(answer?.id)}`);
    if (byId.has(question.id)) throw malformed(`duplicate answer for "${question.id}"`);
    byId.set(question.id, normalizeAnswer(answer, question));
  }
  if (byId.size !== questions.size) throw malformed('the reply must answer every declared question');
  return {
    answers: pack.questions.map((question) => byId.get(question.id)),
    resolvedModel: body.resolvedModel,
    usage: body.usage,
  };
}

async function callOnce(provider, request, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ failure: 'timeout' }), timeoutMs); });
  try {
    return await Promise.race([provider.call(request), timeout]);
  } catch {
    return { failure: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function checkResolvedModel(model, resolvedModel) {
  if (resolvedModel !== undefined && resolvedModel !== model && isPinnedModel(model)) {
    throw new UnusableReply('model-mismatch', `pinned model ${model} resolved to ${resolvedModel}`);
  }
}

/**
 * Ask `provider` the pack's questions about `sanitizedInput`.
 * @returns {Promise<{ status: 'ok'|'unknown'|'error', answers: object[], requestedModel: string, resolvedModel: string|null,
 *   errorClass: string|null, usage: object|null, attemptCount: number, latencyMs: number }>}
 */
export async function evaluateDecision({
  provider,
  model,
  pack,
  sanitizedInput,
  revision,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const request = {
    model,
    revision,
    packId: pack.id,
    questions: pack.questions.map(({ id, kind, prompt, domain, inputs }) => ({
      id,
      kind,
      prompt,
      domain,
      input: Object.fromEntries(inputs.map((name) => [name, sanitizedInput[name]])),
    })),
  };
  const started = Date.now();
  let attemptCount = 0;
  let outcome;
  for (;;) {
    attemptCount += 1;
    outcome = await callOnce(provider, request, timeoutMs);
    if (!(outcome.failure && RETRYABLE.has(outcome.failure) && attemptCount <= MAX_RETRIES)) break;
    await sleep(retryDelayMs);
  }
  const base = { requestedModel: model, attemptCount, latencyMs: Date.now() - started };
  if (outcome.failure) {
    return { status: 'unknown', answers: [], resolvedModel: null, errorClass: outcome.failure, usage: null, ...base };
  }
  const reported = isPlainObject(outcome.body) && typeof outcome.body.resolvedModel === 'string' ? outcome.body.resolvedModel : null;
  try {
    const reply = normalizeReply(outcome.body, pack);
    checkResolvedModel(model, reply.resolvedModel);
    return {
      status: 'ok',
      answers: reply.answers,
      resolvedModel: reported,
      errorClass: null,
      usage: reply.usage ?? null,
      ...base,
    };
  } catch (error) {
    return { status: 'error', answers: [], resolvedModel: reported, errorClass: error.errorClass, usage: null, ...base };
  }
}
