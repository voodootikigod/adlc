// The offline mock provider. It returns a scripted response (the text of
// --mock-response) or a fixed one, and never derives answers from its input, so
// its output can never be mistaken for a signal.
//
// A scripted response is the provider's raw reply. A JSON object whose
// `simulate` field is `timeout`, `rate-limit` or `network` makes the mock fail
// that way instead; anything else is handed on as the reply, malformed or not.

/** The fixed reply: risk medium, no deeper interrogation, both at 0.5. Reduces to unknown. */
export const MOCK_DEFAULT_RESPONSE = JSON.stringify({
  answers: [
    { id: 'risk', value: 'medium', probability: 0.5 },
    { id: 'needs-deeper-interrogation', value: 'no', probability: 0.5 },
  ],
});

const SIMULATED_FAILURES = new Set(['timeout', 'rate-limit', 'network']);

function outcomeFor(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: text };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && SIMULATED_FAILURES.has(parsed.simulate)) {
    return { failure: parsed.simulate };
  }
  return { body: parsed };
}

/**
 * @param {{ responseText?: string }} [options] the scripted reply; the fixed one when absent
 * @returns {{ name: 'mock', call: () => Promise<{ body: unknown } | { failure: string }> }}
 */
export function createMockProvider({ responseText } = {}) {
  const text = responseText ?? MOCK_DEFAULT_RESPONSE;
  return { name: 'mock', call: async () => outcomeFor(text) };
}
