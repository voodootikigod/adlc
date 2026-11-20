// The Jev provider: TypeSafe's System One API over native fetch, built against
// the live responses in test/fixtures/jev-live-2026-10-08.json.
//
// It translates in both directions and judges nothing itself: evaluateDecision
// still validates every answer against the pack and decides the status.
//
// Request. One run is one call (plus bounded retries). TypeSafe judges one
// `state` per call, so every question must declare the same inputs; a pack
// whose questions declare different inputs is rejected rather than split. A
// Choice question's labels become its criteria and a Noul question is sent as
// a yes/no question. Score questions are rejected: no live Score reply has been
// captured, so their mapping would be a guess.
//
// Reply. A Choice answer is its choice, with that choice's probability. A Noul
// answer is TypeSafe's P(yes) = p: `yes` with probability p when p >= 0.5,
// otherwise `no` with probability 1 - p. A tie counts as `yes`, so a coin flip
// escalates rather than passes. The model TypeSafe reports is the resolved
// model; a reply that reports none is malformed. Usage keeps its token counts.
//
// Failures. No response (a network error) is `network` and 429/529 is
// `rate-limit`; both are retried. Any other 5xx is `server-error`, and a 2xx
// whose body breaks off mid-read is `interrupted-response`: no answer, so
// `unknown`, but not retried, since the request may already have been served. Any other non-2xx status (a redirect, a
// rejected key, a refused request) is a rejection, which is `error`, as is a
// 2xx body that is not JSON or is larger than MAX_RESPONSE_BYTES; a body is
// never read past that limit. The HTTP plumbing is shared in common.mjs.

import { API_KEY_PATTERN, MAX_RESPONSE_BYTES, Unsupported, assertApiKey, noulAnswer, postJson, readBounded, sharedInput, singleCallUnsupported } from './common.mjs';

export const DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const ALLOWED_API_HOSTS = Object.freeze(['api.typesafe.ai']);

export { API_KEY_PATTERN, MAX_RESPONSE_BYTES, readBounded, singleCallUnsupported as jevUnsupported };

/** The key is only ever sent to an https URL on an allowlisted host that carries no credentials of its own. */
export function assertSafeApiUrl(value, { allowedHosts = ALLOWED_API_HOSTS } = {}) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new TypeError('the Jev API URL must use https');
  if (url.username || url.password) throw new TypeError('the Jev API URL may not carry credentials');
  const host = url.hostname.toLowerCase();
  const normalized = (allowedHosts ?? ALLOWED_API_HOSTS).map((h) => String(h).toLowerCase());
  if (!normalized.includes(host)) {
    throw new TypeError(`the Jev API URL host "${url.hostname}" is not in the allowlist (${normalized.join(', ')})`);
  }
  return url.href;
}

function typesafeQuestion({ kind, prompt, domain }) {
  if (kind === 'Choice') return { type: 'choice', instructions: prompt, criteria: Object.fromEntries(domain.map((label) => [label, label])) };
  if (kind === 'Noul') return { type: 'noul', instructions: prompt };
  throw new Unsupported('unsupported-question');
}

/** The one TypeSafe request for a provider-neutral request; throws Unsupported when there is none. */
export function typesafeRequest(request) {
  return {
    model: request.model,
    state: sharedInput(request),
    questions: Object.fromEntries(request.questions.map((question) => [question.id, typesafeQuestion(question)])),
  };
}

function neutralAnswer(id, answer) {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return { id, kind: 'not-an-answer', value: answer };
  if (answer.type === 'choice') {
    if (typeof answer.choice !== 'string') return { id, kind: 'not-an-answer', value: answer.choice };
    const { probabilities } = answer;
    const probability = probabilities !== null && typeof probabilities === 'object' && Object.hasOwn(probabilities, answer.choice)
      ? probabilities[answer.choice]
      : undefined;
    return {
      id,
      kind: 'Choice',
      value: answer.choice,
      ...(probability === undefined ? {} : { probability }),
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    };
  }
  if (answer.type === 'noul') return noulAnswer(id, answer.noul);
  return { id, kind: String(answer.type), value: undefined };
}

// An answer that is not TypeSafe's shape keeps a kind or probability the
// neutral validation always rejects, so it is malformed even when its raw value
// happens to be in the pack's domain.

/**
 * Translate a TypeSafe reply into the neutral reply body evaluateDecision
 * validates. Anything that is not the expected shape is passed on in a form
 * that validation rejects; an answer TypeSafe omitted stays missing.
 */
export function neutralBody(reply) {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return reply;
  const { answers, model, usage } = reply;
  const resolvedModel = { resolvedModel: typeof model === 'string' ? model : null };
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return { answers, ...resolvedModel };
  const counters = usage === null ? undefined : typeof usage === 'object' && !Array.isArray(usage)
    ? {
      ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
      ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
    }
    : usage;
  return {
    answers: Object.entries(answers).map(([id, answer]) => neutralAnswer(id, answer)),
    ...resolvedModel,
    ...(counters === undefined ? {} : { usage: counters }),
  };
}

/**
 * @param {{ apiKey: string, apiUrl?: string, fetch?: typeof fetch }} options
 * @returns {{ name: 'jev', call: (request: object, options?: { signal?: AbortSignal }) => Promise<{ body: unknown } | { failure: string } | { rejected: string, dispatched?: false }> }}
 */
export function createJevProvider({ apiKey, apiUrl = DEFAULT_API_URL, allowedHosts = ALLOWED_API_HOSTS, fetch: fetchImpl = globalThis.fetch }) {
  assertApiKey(apiKey, 'the Jev API key');
  const url = assertSafeApiUrl(apiUrl, { allowedHosts });
  return {
    name: 'jev',
    async call(request, { signal } = {}) {
      let body;
      try {
        body = typesafeRequest(request);
      } catch (error) {
        if (error instanceof Unsupported) return { rejected: error.errorClass, dispatched: false };
        throw error;
      }
      return postJson({ fetchImpl, apiUrl: url, apiKey, signal }, body, neutralBody);
    },
  };
}
