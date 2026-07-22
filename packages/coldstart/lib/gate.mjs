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
export function buildCheckTicket(completeFn, extractJsonFn, tier = 'cheap') {
  return async function checkTicketWith(ticket) {
    const prompt = buildPrompt(ticket);
    let usage = null;
    const raw = await completeFn({
      tier,
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: 1024,
      // Real completeFn is core's complete(), which respects onUsage
      // (issue #272). Injected test stubs simply won't call it — usage
      // stays null, which the caller treats as "nothing to report", not
      // an error.
      onUsage: (u) => { usage = u; },
    });
    const parsed = extractJsonFn(raw);
    const gaps = Array.isArray(parsed?.gaps) ? parsed.gaps : [];
    return { id: ticket.id, gaps, usage };
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
export async function checkTicket(ticket, tier = 'cheap') {
  const mockEnv = process.env.ADLC_GATE_MOCK_RESPONSE;
  if (mockEnv !== undefined && process.env.NODE_ENV === 'test') {
    let parsed = {};
    try {
      parsed = JSON.parse(mockEnv);
    } catch (e) {
      // Ignored: fallback to {}
    }
    const gaps = Array.isArray(parsed?.gaps) ? parsed.gaps : [];
    // No real LLM call was made — nothing to report (never fabricate usage).
    return { id: ticket.id, gaps, usage: null };
  }
  return buildCheckTicket(coreComplete, coreExtractJson, tier)(ticket);
}

/**
 * Run cold-start checks for every ticket in the array.
 * Returns an array of { id, gaps, usage } in the same order. `usage` is
 * `{inputTokens, outputTokens, cachedTokens, provider, model, tier}` when
 * the provider reported it, else null (mock/agy paths, or a provider that
 * didn't return a usage block).
 * Throws on the first LLM error (fail-fast for operational errors).
 */
export async function checkAll(tickets, tier = 'cheap') {
  const results = [];
  for (const ticket of tickets) {
    results.push(await checkTicket(ticket, tier));
  }
  return results;
}

/**
 * Sum per-ticket usage from checkAll's results into one manifest-shaped
 * `data.usage` object (issue #272 — coldstart is the reference wiring for
 * "a gate reports usage to gate-manifest"). Tickets with no reported usage
 * (mock/agy) simply don't contribute; provider/model/tier are taken from
 * the first ticket that DID report usage (a single coldstart invocation
 * always uses one tier/provider across all its targets).
 *
 * Returns null when no result reported usage — callers should skip
 * recording rather than write a zeroed/fabricated entry.
 *
 * @param {Array<{id:string, gaps:object[], usage:object|null}>} results
 * @returns {{inputTokens:number, outputTokens:number, cachedTokens:number, provider:string, model:string, tier:string}|null}
 */
export function aggregateCheckAllUsage(results) {
  const withUsage = results.filter((r) => r.usage);
  if (withUsage.length === 0) return null;
  const { provider, model, tier } = withUsage[0].usage;
  return withUsage.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + (r.usage.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (r.usage.outputTokens ?? 0),
      cachedTokens: acc.cachedTokens + (r.usage.cachedTokens ?? 0),
      provider,
      model,
      tier,
    }),
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0, provider, model, tier }
  );
}
