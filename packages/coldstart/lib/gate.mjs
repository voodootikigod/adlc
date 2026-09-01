// Orchestration logic for the coldstart gate.
// Calls the LLM (or returns prompt for --prompt-only), parses results.

import { complete as coreComplete, extractJson as coreExtractJson, detectProvider, resolveModel } from '@adlc/core';
import { ticketHash } from '@adlc/tickets';
import { loadFiltered } from '@adlc/gate-manifest/lib/show.mjs';
import { buildPrompt, SYSTEM_PROMPT } from './prompt.mjs';
import { findCachedVerdict } from './cache.mjs';
import { normalizeGaps, UNREADABLE_VERDICT_PREFIX } from './normalize-gaps.mjs';

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
    // Issue #594: a well-formed reply of the WRONG shape is "could not read the
    // verdict", never "no gaps". normalizeGaps throws; the caller's operational
    // error path (exit 1) reports it. A bare top-level array is recovered.
    const gaps = normalizeGaps(parsed);
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
    // The seam fails closed exactly like the real path (issue #594): an
    // unparseable or shape-deviant mock is an unreadable verdict, not `[]`.
    let parsed;
    try {
      parsed = JSON.parse(mockEnv);
    } catch (e) {
      throw new Error(`${UNREADABLE_VERDICT_PREFIX} ADLC_GATE_MOCK_RESPONSE is not valid JSON (${e.message})`);
    }
    const gaps = normalizeGaps(parsed);
    // No real LLM call was made — nothing to report (never fabricate usage),
    // and `mocked: true` tells the caller never to cache this result either
    // (issue #278): a mocked verdict must not be able to shadow, or later
    // BE shadowed by, a real audit of the same ticket content.
    return { id: ticket.id, gaps, usage: null, mocked: true };
  }
  return buildCheckTicket(coreComplete, coreExtractJson, tier)(ticket);
}

/**
 * Resolve the model id that a real (non-mock) checkTicket call for this tier
 * would use, WITHOUT making an LLM call — the same resolution complete()
 * does internally (detectProvider + resolveModel), surfaced so the cache
 * layer can key on it and so a recorded verdict can be looked up again
 * later. Returns null when no provider is configured (mirrors complete()'s
 * own fail path — with no provider there's nothing to key a cache on, and
 * checkTicket will throw its own clear error when actually called).
 *
 * @param {string} tier
 * @param {object} [env]
 * @returns {string|null}
 */
export function resolveExpectedModel(tier, env = process.env) {
  const provider = detectProvider(env);
  if (!provider) return null;
  return resolveModel(provider, { tier }, env);
}

/**
 * Run cold-start checks for every ticket in the array.
 * Returns an array of { id, gaps, usage, cached } in the same order. `usage`
 * is `{inputTokens, outputTokens, cachedTokens, provider, model, tier}` when
 * the provider reported it, else null (mock/agy paths, cache hits, or a
 * provider that didn't return a usage block). `cached: true` means the
 * verdict was reused from a prior gate-manifest entry, not freshly audited.
 * Throws on the first LLM error (fail-fast for operational errors).
 *
 * Content-addressed caching (issue #278): a ticket whose content hash
 * (`ticketHash` — the same domain-separated hash `@adlc/tickets` uses for
 * store binding, so a coldstart cache entry and a ticket-store snapshot
 * agree on what "unchanged" means) matches a prior gate-manifest entry for
 * the SAME resolved model skips the LLM call entirely and reuses that
 * entry's gaps. Caching is keyed on the RESOLVED model id, not the abstract
 * tier — switching `ADLC_MODEL_CHEAP` changes what "cheap" resolves to, and
 * a cache entry from the old model must not silently cover the new one.
 *
 * @param {object[]} tickets
 * @param {string} [tier]
 * @param {object} [opts]
 * @param {boolean} [opts.force] - skip the cache entirely, re-audit everything
 * @param {number|null} [opts.maxAgeMs] - cache entries older than this are treated as stale; null = no age limit
 * @param {number} [opts.now] - injectable clock (ms since epoch) for tests
 * @param {string} [opts.dir] - gate-manifest ledger directory, default ADLC_DIR
 * @param {Function} [opts.checkTicketFn] - injectable (ticket) => Promise<{id,gaps,usage}>, default checkTicket bound to `tier`
 * @param {Function} [opts.loadCacheEntriesFn] - injectable (ticketId) => manifest entries[], default reads the real gate-manifest ledger
 * @param {Function} [opts.resolveModelFn] - injectable () => string|null, default resolveExpectedModel(tier)
 */
export async function checkAll(tickets, tier = 'cheap', opts = {}) {
  const {
    force = false,
    maxAgeMs = null,
    now = Date.now(),
    dir,
    checkTicketFn = (ticket) => checkTicket(ticket, tier),
    loadCacheEntriesFn = (ticketId) => defaultLoadCacheEntries(ticketId, dir),
    resolveModelFn = () => resolveExpectedModel(tier),
  } = opts;

  // The ADLC_GATE_MOCK_RESPONSE test seam (checkTicket, above) exists to make
  // the CLI's output/exit-code paths deterministic and network-free — a
  // cache hit silently overriding that would make mock-driven tests
  // order-dependent on whatever a PRIOR real audit happened to cache for the
  // same ticket content. Caching is a real-execution optimization; defer to
  // the mock seam rather than compete with it.
  const mockSeamActive = process.env.ADLC_GATE_MOCK_RESPONSE !== undefined && process.env.NODE_ENV === 'test';
  const model = (force || mockSeamActive) ? null : resolveModelFn();

  const results = [];
  for (const ticket of tickets) {
    if (!force && model) {
      const hash = ticketHash(ticket);
      const entries = loadCacheEntriesFn(ticket.id);
      const cached = findCachedVerdict(entries, { ticketHash: hash, model, maxAgeMs, now });
      if (cached) {
        results.push({ id: ticket.id, gaps: cached.gaps, usage: null, cached: true });
        continue;
      }
    }
    const result = await checkTicketFn(ticket);
    results.push({ ...result, cached: false });
  }
  return results;
}

function defaultLoadCacheEntries(ticketId, dir) {
  return loadFiltered({ ticket: ticketId, dir }).entries;
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

/**
 * Validate a single ticket deterministically without network or LLM calls.
 * Checks completeness of ticket fields and input contracts:
 * - body: must be a non-empty string explaining requirements
 * - scope: must be a non-empty array of non-empty strings
 * - rails: if present, must be an array of non-empty strings
 * - edges: if present, must be an array of valid edge objects with non-empty "to"
 *   and non-empty "contract" (if contract is specified)
 * - edge targets: if allTickets provided, edge.to must point to a known ticket
 * - duration: if present, must be a positive finite number
 *
 * @param {object} ticket
 * @param {object[]} [allTickets]
 * @returns {{ id: string, gaps: Array<{what: string, why_blocking: string}>, usage: null, cached: false, offline: true }}
 */
export function checkTicketOffline(ticket, allTickets = []) {
  const gaps = [];

  if (!ticket || typeof ticket !== 'object') {
    return {
      id: ticket?.id ?? '?',
      gaps: [{ what: 'invalid ticket', why_blocking: 'ticket must be an object' }],
      usage: null,
      cached: false,
      offline: true,
    };
  }

  if (!ticket.body || typeof ticket.body !== 'string' || !ticket.body.trim()) {
    gaps.push({
      what: 'missing body',
      why_blocking: 'ticket has no description or body explaining requirements',
    });
  }

  if (!ticket.scope || !Array.isArray(ticket.scope) || ticket.scope.length === 0) {
    gaps.push({
      what: 'missing scope',
      why_blocking: 'ticket has no declared file scope globs',
    });
  } else if (ticket.scope.some((s) => typeof s !== 'string' || !s.trim())) {
    gaps.push({
      what: 'invalid scope',
      why_blocking: 'ticket scope contains empty or non-string entries',
    });
  }

  if (ticket.rails !== undefined) {
    if (!Array.isArray(ticket.rails) || ticket.rails.some((r) => typeof r !== 'string' || !r.trim())) {
      gaps.push({
        what: 'invalid rails',
        why_blocking: 'ticket rails must be an array of non-empty string globs',
      });
    }
  }

  if (ticket.edges !== undefined) {
    if (!Array.isArray(ticket.edges)) {
      gaps.push({
        what: 'invalid edges',
        why_blocking: 'ticket edges must be an array',
      });
    } else {
      for (const edge of ticket.edges) {
        if (!edge || typeof edge !== 'object' || Array.isArray(edge) || typeof edge.to !== 'string' || !edge.to.trim()) {
          gaps.push({
            what: 'invalid edge',
            why_blocking: 'edge is missing string "to" target ticket id',
          });
        } else {
          if (allTickets && allTickets.length > 0 && !allTickets.some((t) => t.id === edge.to)) {
            gaps.push({
              what: 'unknown edge target',
              why_blocking: `edge points to unknown ticket ${edge.to}`,
            });
          }
          if (edge.contract !== undefined && (typeof edge.contract !== 'string' || !edge.contract.trim())) {
            gaps.push({
              what: 'invalid edge contract',
              why_blocking: `edge to ${edge.to} has invalid contract definition`,
            });
          }
        }
      }
    }
  }

  if (ticket.duration !== undefined && (typeof ticket.duration !== 'number' || !Number.isFinite(ticket.duration) || ticket.duration <= 0)) {
    gaps.push({
      what: 'invalid duration',
      why_blocking: 'ticket duration must be a positive number',
    });
  }

  return { id: ticket.id, gaps, usage: null, cached: false, offline: true };
}

/**
 * Run deterministic offline cold-start validation for every ticket in the array.
 *
 * @param {object[]} tickets - target tickets
 * @param {object[]} [allTickets] - all tickets in store
 * @returns {Array<{id: string, gaps: Array<{what: string, why_blocking: string}>, usage: null, cached: false, offline: true}>}
 */
export function checkAllOffline(tickets, allTickets = tickets) {
  return tickets.map((t) => checkTicketOffline(t, allTickets));
}
