// lib/prompt.mjs — build the premortem prompt from spec content.

export const SYSTEM_PROMPT =
  'You are an adversarial premortem analyst. The project described FAILED. Be concrete and mechanistic, not generic.';

/**
 * Build the user prompt for the premortem LLM call.
 * @param {string} specContent  — raw text of the spec file
 * @returns {string}
 */
export function buildPrompt(specContent) {
  return (
    specContent.trim() +
    '\n\n' +
    'It is three months later and this project FAILED in production. ' +
    'Write the postmortem. ' +
    'Output JSON {"causes":[{"cause":string,"earliest_signal":string,"prevention":string,"interrogation_question":string}]} ' +
    '— 5 to 10 causes, each specific to THIS spec (reference its actual features), no generic platitudes.'
  );
}
