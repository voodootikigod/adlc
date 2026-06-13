// Orchestration logic for the coldstart gate.
// Calls the LLM (or returns prompt for --prompt-only), parses results.

import { complete as coreComplete, extractJson as coreExtractJson } from '@adlc/core';
import { buildPrompt, SYSTEM_PROMPT } from './prompt.mjs';

/**
 * Build a checkTicket function bound to specific complete/extractJson
 * implementations. Used for unit testing without network access.
 *
 * @param {Function} completeFn - async (opts) => string
 * @param {Function} extractJsonFn - (text) => object
 */
export function buildCheckTicket(completeFn, extractJsonFn) {
  return async function checkTicketWith(ticket) {
    const prompt = buildPrompt(ticket);
    const raw = await completeFn({
      tier: 'cheap',
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: 1024,
    });
    const parsed = extractJsonFn(raw);
    const gaps = Array.isArray(parsed?.gaps) ? parsed.gaps : [];
    return { id: ticket.id, gaps };
  };
}

/**
 * Run a single cold-start check against a ticket.
 * Returns { id, gaps: [{what, why_blocking}] }.
 * Throws on LLM/network errors (caller handles with opError).
 *
 * ADLC_GATE_MOCK_RESPONSE is a TEST-ONLY seam: it is honored ONLY when
 * NODE_ENV === 'test'. In that case it is parsed as a JSON string and
 * returned directly (skipping the real LLM call), letting CLI integration
 * tests exercise the full output and exit-code paths without network access.
 *
 * In any non-test run the env var is IGNORED and the real LLM path is taken.
 * This closes the F5 backdoor where ambient, agent-controlled env data could
 * force a green executability verdict with no LLM call. The real path fails
 * closed when no API key is configured — which is the correct behavior.
 */
export async function checkTicket(ticket) {
  const mockEnv = process.env.ADLC_GATE_MOCK_RESPONSE;
  if (mockEnv !== undefined && process.env.NODE_ENV === 'test') {
    const parsed = JSON.parse(mockEnv);
    const gaps = Array.isArray(parsed?.gaps) ? parsed.gaps : [];
    return { id: ticket.id, gaps };
  }
  return buildCheckTicket(coreComplete, coreExtractJson)(ticket);
}

/**
 * Run cold-start checks for every ticket in the array.
 * Returns an array of { id, gaps } in the same order.
 * Throws on the first LLM error (fail-fast for operational errors).
 */
export async function checkAll(tickets) {
  const results = [];
  for (const ticket of tickets) {
    results.push(await checkTicket(ticket));
  }
  return results;
}
