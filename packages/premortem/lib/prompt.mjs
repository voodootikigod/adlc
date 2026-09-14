// lib/prompt.mjs — build the premortem prompt from spec content.

import { fence } from '@adlc/core';

// The spec IS the payload here, not one field among many, so any cap truncates
// the very artifact under review — and fence() is tail-biased, so an over-cap
// spec would silently lose its OPENING sections (#1007). The cap is therefore
// deliberately generous rather than the 8000 used elsewhere: large enough that
// a realistic spec is never truncated, while still bounding a pathological one.
const SPEC_MAX_CHARS = 64_000;

export const SYSTEM_PROMPT =
  'You are an adversarial premortem analyst. The project described FAILED. Be concrete and mechanistic, not generic.';

/**
 * Build the user prompt for the premortem LLM call.
 * @param {string} specContent  — raw text of the spec file
 * @returns {string}
 */
export function buildPrompt(specContent) {
  return (
    fence('SPEC', specContent.trim(), SPEC_MAX_CHARS) +
    '\n\n' +
    'It is three months later and this project FAILED in production. ' +
    'Write the postmortem. ' +
    'Output JSON {"causes":[{"cause":string,"earliest_signal":string,"prevention":string,"interrogation_question":string}]} ' +
    '— 5 to 10 causes, each specific to THIS spec (reference its actual features), no generic platitudes.'
  );
}
