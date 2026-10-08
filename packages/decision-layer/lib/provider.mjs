// The provider-neutral call path and the adapter contract's status rules.
//
// A provider's call() resolves to { body } (a reply arrived), { failure }
// (none did: 'timeout', 'rate-limit', 'network', 'server-error' or
// 'interrupted-response') or { rejected } (the provider answered but refused
// the request, naming why; with dispatched: false the adapter refused it before
// sending anything, so no attempt is counted). No reply is `unknown`; a reply that is unusable or
// a rejection is `error`. A call that times out is aborted through the signal
// it was given. None ever carries a fabricated answer. Only rate-limit and
// network failures are retried, at most MAX_RETRIES times; every other failure
// ends the run on its first attempt.
//
// The request is canonical JSON (keys sorted at every level) and carries the model, the pack ID and each question's pack-authored
// text (id, kind, prompt, domain) with only the sanitized input fields that
// question declares. Nothing else derived from the repository is sent: in
// particular not the revision, which the run records but the provider never sees.
// Each question is sent only the input fields it declares.
//
// Pack-authored text is repository text when the pack is a project pack, so
// every pack and question id, prompt and domain value is scanned before dispatch and a pack carrying
// a credential-shaped value is refused (it is not silently redacted). The whole
// request is held to the sanitizer's limits: 4 KiB per string, 32 KiB in total.
//
// A reply's usage keeps only the counters in USAGE_COUNTERS, each a
// non-negative integer; any other key is dropped, and a usage of any other shape
// is malformed. A resolved model must be a valid model ID. A model ID ending
// in -<major>.<minor>.<patch> is pinned: a reply that resolves it to any other
// model is `error`. Any other ID is an alias, which may resolve to anything.
// The resolved model is whatever the reply reported, kept even when the reply
// is otherwise unusable, and null when no reply arrived or none was reported.
import { isPlainObject } from '@adlc/core';
import { MAX_FIELD_BYTES, MAX_TOTAL_BYTES, PackError, packHash } from './pack.mjs';
import { canonicalBytes, canonicalJson } from './canonical.mjs';
import { MODEL_PATTERN } from './config.mjs';
import { SanitizationError, scanText } from './sanitizer.mjs';

export const MAX_RETRIES = 2;
export const USAGE_COUNTERS = Object.freeze(['inputTokens', 'outputTokens', 'totalTokens']);
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

function refuseCredentialText(pack) {
  if (scanText(pack.id).redactions > 0) throw new PackError('the pack id carries a credential-shaped value; the pack is refused');
  for (const question of pack.questions) {
    const fields = [
      ['id', question.id],
      ['prompt', question.prompt],
      ...(Array.isArray(question.domain) ? question.domain.map((value) => ['domain', value]) : []),
    ];
    for (const [field, text] of fields) {
      if (typeof text === 'string' && scanText(text).redactions > 0) {
        throw new PackError(`a question ${field} carries a credential-shaped value; the pack is refused`);
      }
    }
  }
}

function strings(value) {
  if (typeof value === 'string') return [value];
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
  return [];
}

function boundRequest(request) {
  if (strings(request).some((text) => Buffer.byteLength(text, 'utf8') > MAX_FIELD_BYTES)) {
    throw new SanitizationError('request-field-too-large', `a string in the provider request exceeds ${MAX_FIELD_BYTES} bytes`);
  }
  if (canonicalBytes(request) > MAX_TOTAL_BYTES) {
    throw new SanitizationError('request-too-large', `the provider request exceeds ${MAX_TOTAL_BYTES} bytes`);
  }
}

function normalizeUsage(usage) {
  if (usage === undefined) return undefined;
  if (!isPlainObject(usage)) throw malformed('usage must be an object');
  const counters = {};
  for (const [key, value] of Object.entries(usage)) {
    if (value !== null && typeof value === 'object') throw malformed('usage may not nest values');
    if (!USAGE_COUNTERS.includes(key)) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw malformed(`usage ${key} must be a non-negative integer`);
    counters[key] = value;
  }
  return counters;
}

const validModel = (model) => typeof model === 'string' && MODEL_PATTERN.test(model);

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
  if (body.resolvedModel !== undefined && !validModel(body.resolvedModel)) throw malformed('resolvedModel must be a valid model ID');
  const usage = normalizeUsage(body.usage);
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
    usage,
  };
}

async function callOnce(provider, request, timeoutMs) {
  let timer;
  const controller = new AbortController();
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ failure: 'timeout' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.call(request, { signal: controller.signal }), timeout]);
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
 * @returns {Promise<{ status: 'ok'|'unknown'|'error', answers: object[], requestedModel: string, resolvedModel: string|null, packHash: string,
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
  const request = JSON.parse(canonicalJson({
    model,
    packId: pack.id,
    questions: pack.questions.map(({ id, kind, prompt, domain, inputs }) => ({
      id,
      kind,
      prompt,
      domain,
      input: Object.fromEntries(inputs.map((name) => [name, sanitizedInput[name]])),
    })),
  }));
  refuseCredentialText(pack);
  boundRequest(request);
  const started = Date.now();
  let attemptCount = 0;
  let outcome;
  for (;;) {
    attemptCount += 1;
    outcome = await callOnce(provider, request, timeoutMs);
    if (!(outcome.failure && RETRYABLE.has(outcome.failure) && attemptCount <= MAX_RETRIES)) break;
    await sleep(retryDelayMs);
  }
  if (outcome.rejected && outcome.dispatched === false) attemptCount = 0;
  const base = { requestedModel: model, packHash: packHash(pack), attemptCount, latencyMs: Date.now() - started };
  if (outcome.failure) {
    return { status: 'unknown', answers: [], resolvedModel: null, errorClass: outcome.failure, usage: null, ...base };
  }
  if (outcome.rejected) {
    return { status: 'error', answers: [], resolvedModel: null, errorClass: outcome.rejected, usage: null, ...base };
  }
  const reported = isPlainObject(outcome.body) && validModel(outcome.body.resolvedModel) ? outcome.body.resolvedModel : null;
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
