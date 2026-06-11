// Orchestration logic for the coldstart gate.
// Calls the LLM (or returns prompt for --prompt-only), parses results.

import { complete as coreComplete, extractJson as coreExtractJson } from '../../core/index.mjs';
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
 * When AIDLC_GATE_MOCK_RESPONSE is set in the environment it is parsed as
 * a JSON string and returned directly (skipping the real LLM call). This
 * allows CLI integration tests to exercise the full output and exit-code
 * paths without network access.
 */
export async function checkTicket(ticket) {
  const mockEnv = process.env.AIDLC_GATE_MOCK_RESPONSE;
  if (mockEnv !== undefined) {
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
