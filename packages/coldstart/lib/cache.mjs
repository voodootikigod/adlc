// cache.mjs — content-addressed gate-result cache (issue #278).
//
// ADLC Principle 10: "every artifact the next agent reads is a cache" — a
// coldstart PASS/FAIL for a given ticket-hash is valid exactly as long as
// that hash is unchanged. Pure lookup logic lives here (testable with plain
// fixture arrays, no real gate-manifest I/O); gate.mjs wires it to the real
// ledger and to ticketHash().

import { ticketHash as computeTicketHash } from '@adlc/tickets';
import { normalizeGaps } from './normalize-gaps.mjs';

export const GATE_NAME = 'coldstart';

/**
 * Build the `data.cache` shape recorded into a gate-manifest entry for one
 * audited ticket.
 *
 * @param {object} opts
 * @param {string} opts.ticketHash
 * @param {string} opts.model - resolved model id, not the abstract tier
 * @param {object[]} opts.gaps
 * @returns {{ticketHash:string, model:string, gaps:object[]}}
 */
export function buildCacheData({ ticketHash, model, gaps }) {
  return { ticketHash, model, gaps: gaps ?? [] };
}

/**
 * Find the most recent cached coldstart verdict matching `ticketHash` +
 * `model` among manifest entries already scoped to one ticket (the caller
 * filters by `ticket` when loading — see gate.mjs's loadCacheEntriesFn).
 *
 * Walks newest-first so a later re-audit (e.g. after `--force`) shadows an
 * older entry for the same hash+model rather than the lookup depending on
 * array order elsewhere.
 *
 * @param {object[]} entries - manifest entries (as returned by gate-manifest's loadFiltered)
 * @param {object} opts
 * @param {string} opts.ticketHash
 * @param {string} opts.model
 * @param {number|null} [opts.maxAgeMs] - null = no age limit
 * @param {number} [opts.now] - ms since epoch; defaults to Date.now()
 * @returns {{gaps:object[]}|null}
 */
export function findCachedVerdict(entries, { ticketHash, model, maxAgeMs = null, now = Date.now() } = {}) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.gate !== GATE_NAME) continue;
    const cache = entry.data?.cache;
    if (!cache || cache.ticketHash !== ticketHash || cache.model !== model) continue;
    if (maxAgeMs != null) {
      const ageMs = now - Date.parse(entry.ts);
      if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) continue;
    }
    // Issue #594: a stored verdict whose gaps are not a readable list must never
    // be served as a clean cache hit. It is skipped (the walk continues to an
    // older readable entry, else the caller re-audits) rather than coerced to [].
    let gaps;
    try {
      gaps = normalizeGaps(cache.gaps);
    } catch {
      continue;
    }
    return { gaps };
  }
  return null;
}

/**
 * Build the list of gate-manifest record() calls a coldstart run should
 * make: one per ticket that was actually audited this run — never for a
 * cache hit (it reuses prior evidence, recording again would just duplicate
 * it) and never for the ADLC_GATE_MOCK_RESPONSE test seam (`mocked: true` —
 * no real call was made, nothing real to report). Returns `[]` when there
 * is nothing to record, which the caller can iterate directly with no
 * separate "is there anything to record?" branch to test.
 *
 * @param {Array<{id:string, gaps:object[], usage:object|null, cached?:boolean, mocked?:boolean}>} results
 * @param {object[]} targets - the ticket objects checkAll was run against, same order/ids as results
 * @param {object} opts
 * @param {string|null} opts.model - resolveExpectedModel's output; null means no provider was configured, so no cache data can be keyed
 * @param {string} opts.tier
 * @returns {Array<{gate:string, ticket:string, rawData:string}>}
 */
export function buildRecordPlan(results, targets, { model, tier }) {
  const targetsById = new Map(targets.map((t) => [t.id, t]));
  return results
    .filter((r) => !r.cached && !r.mocked)
    .map((result) => {
      const ticket = targetsById.get(result.id);
      const data = { tier };
      if (model) data.cache = buildCacheData({ ticketHash: computeTicketHash(ticket), model, gaps: result.gaps });
      if (result.usage) data.usage = result.usage;
      return { gate: GATE_NAME, ticket: result.id, rawData: JSON.stringify(data) };
    });
}
